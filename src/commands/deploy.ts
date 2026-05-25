// `agentq deploy` — central deployment.
//
// Two modes:
//   Legacy (no --tier, no gitops.enabled):
//       Uses cfg.deployment.resource_name persisted in agentq.config.yaml.
//       Identical to behavior before GitOps was added.
//
//   Tier   (--tier given OR gitops.enabled=true):
//       Wraps `agentq state plan` + `agentq state apply` internally.
//       State lives in GCS, not in tracked YAML.
//       Drift is detected before apply. Concurrent deploys are caught by
//       the GCS generation precondition.
import path from 'node:path';
import fs from 'fs-extra';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot, projectPaths, readPackageVersion } from '../lib/paths.js';
import { loadConfig, TIERS } from '../lib/config.js';
import { resolveTarget } from '../lib/tier-resolver.js';
import { downloadState, uploadStateIfChanged, gitHeadSha } from '../lib/state-sync.js';
import { runPython } from '../lib/python.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  'project-dir'?: string;
  tier?: string;
  update: boolean;
  recreate: boolean;
  'resource-name'?: string;
  reinstall: boolean;
}

export const deployCommand: CommandModule<{}, Args> = {
  command: 'deploy',
  describe: 'Create or update the Reasoning Engine for this project.',
  builder: (y: Argv) =>
    y.option('project-dir',   { type: 'string', describe: 'Project root (defaults to walk-up from cwd).' })
     .option('tier',          { type: 'string', choices: TIERS as readonly string[], describe: 'Deploy to a specific tier (GitOps mode).' })
     .option('update',        { type: 'boolean', default: false, describe: '(legacy only) Force update mode.' })
     .option('recreate',      { type: 'boolean', default: false, describe: '(legacy only) Force creation of a NEW Reasoning Engine even if one is persisted.' })
     .option('resource-name', { type: 'string', describe: '(legacy only) Override deployment.resource_name from the config.' })
     .option('reinstall',     { type: 'boolean', default: false, describe: 'Recreate the .agentq Python venv before deploying.' })
     .conflicts('update', 'recreate') as Argv<Args>,
  handler: async (argv) => {
    const root = argv['project-dir']
      ? path.resolve(argv['project-dir'])
      : (await findProjectRoot()) ?? null;
    if (!root) {
      throw new AgentqError(
        'No agentq.config.yaml found in cwd or any parent directory.',
        'Run `agentq init` first, or pass --project-dir.',
      );
    }
    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const pp = projectPaths(root, cfg.project.package);

    if (!(await fs.pathExists(pp.packageDir))) {
      throw new AgentqError(`Python package not found at ${pp.packageDir}`);
    }

    if (argv.reinstall) {
      const stamp = path.join(pp.agentqDir, 'venv.requirements.lock');
      if (await fs.pathExists(stamp)) await fs.remove(stamp);
    }

    const target = resolveTarget(cfg, argv.tier);

    if (target.tier) {
      // Reject legacy-only flags in tier mode — they don't have meaningful
      // semantics here (the GCS state file is the source of truth).
      for (const flag of ['update', 'recreate', 'resource-name'] as const) {
        if (argv[flag]) {
          throw new AgentqError(
            `--${flag} is not supported in tier mode (--tier ${target.tier}).`,
            'Use `agentq state plan` + `agentq state apply` for finer control, or `agentq destroy --tier <t>` + a fresh `agentq deploy --tier <t>` to recreate.',
          );
        }
      }
      await deployTierMode(cfg, pp, target, root);
      return;
    }

    // ── Legacy mode (single resource_name in tracked YAML) ─────────────────
    const hasPersisted = cfg.deployment.resource_name != null;
    let mode: 'create' | 'update';
    let reason: string;
    if (argv.recreate) {
      mode = 'create';
      reason = hasPersisted
        ? `--recreate forced — abandoning ${cfg.deployment.resource_name}`
        : '--recreate (no persisted resource yet)';
    } else if (argv.update) {
      mode = 'update';
      reason = '--update forced';
    } else if (hasPersisted) {
      mode = 'update';
      reason = `resource_name found in agentq.config.yaml`;
    } else {
      mode = 'create';
      reason = 'first deploy — no resource_name persisted yet';
    }

    if (argv.update && !hasPersisted && !argv['resource-name']) {
      throw new AgentqError(
        '--update requested but no resource_name is persisted in agentq.config.yaml.',
        'Either drop the flag (a first deploy auto-creates) or pass --resource-name explicitly.',
      );
    }

    const args = [path.join(pp.root, 'agentq.config.yaml')];
    args.push(mode === 'update' ? '--update' : '--create');
    if (argv['resource-name']) args.push('--resource-name', argv['resource-name']);

    log.banner(`Deploying ${cfg.project.display_name}`);
    log.info(`mode: ${mode}  (${reason})  [legacy]`);
    log.info(`project: ${cfg.deployment.gcp_project}`);
    log.info(`location: ${cfg.deployment.location}`);
    log.info(`staging_bucket: ${cfg.deployment.staging_bucket}`);
    if (mode === 'create' && hasPersisted) {
      log.warn(
        `Previous resource ${cfg.deployment.resource_name} is NOT being deleted. ` +
        `Run \`agentq destroy ${cfg.deployment.resource_name}\` if you want to clean it up.`,
      );
    }

    try {
      await runPython(pp, 'agentq_runtime.deploy', args);
      log.success('Deploy completed.');
    } catch (err) {
      const code = (err as { exitCode?: number }).exitCode;
      if (code === 3) {
        throw new AgentqError(
          `Persisted resource ${cfg.deployment.resource_name} no longer exists.`,
          'Run `agentq deploy --recreate` to deploy a fresh Reasoning Engine. The new resource_name will replace the stale one in agentq.config.yaml automatically.',
        );
      }
      throw err;
    }
  },
};

async function deployTierMode(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  pp: ReturnType<typeof projectPaths>,
  target: ReturnType<typeof resolveTarget>,
  root: string,
): Promise<void> {
  log.banner(`Deploying ${target.display_name}`);
  log.info(`tier: ${target.tier}`);
  log.info(`project: ${target.gcp_project}`);
  log.info(`location: ${target.location}`);
  log.info(`state: ${target.state_bucket}/${target.state_path}`);

  // 1. Download current state (may not exist on first deploy).
  const { localPath, generation, existed } = await downloadState(target);

  // 2. Compute a plan file.
  const sha = await gitHeadSha(root);
  const planDir = path.join(pp.agentqDir, 'plans');
  await fs.ensureDir(planDir);
  const planPath = path.join(planDir, `${target.tier}-${sha.slice(0, 8)}.json`);

  const cfgFile = path.join(pp.root, 'agentq.config.yaml');
  const cliVer = await readPackageVersion();
  const baseArgs = [
    '--config-file', cfgFile,
    '--state-file', localPath,
    '--tier', target.tier!,
    '--source-sha', sha,
    '--cli-version', cliVer,
  ];

  const planArgs = ['plan', ...baseArgs, '--plan-out', planPath];
  if (generation !== null) planArgs.push('--state-generation', String(generation));
  await runPython(pp, 'agentq_runtime.state', planArgs);

  // 3. Apply the plan.
  const applyArgs = ['apply', ...baseArgs, '--plan', planPath];
  if (generation !== null) applyArgs.push('--state-generation', String(generation));
  await runPython(pp, 'agentq_runtime.state', applyArgs);

  // 4. Upload the mutated state back to GCS with concurrency check.
  await uploadStateIfChanged(target, localPath, existed ? generation : null);
  log.success('Deploy completed.');
}
