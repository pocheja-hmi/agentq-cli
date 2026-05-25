// `agentq state` — yargs group of state operations.
//
// All six subcommands (show / diff / plan / apply / import / rm) follow the
// same skeleton: locate project → load config → resolve target → download
// state from GCS → invoke Python runtime against a local copy → upload any
// changes back with generation-token concurrency.
//
// We keep this in ONE file (not one per subcommand) because the skeleton is
// almost identical and the per-subcommand divergence is purely the args we
// pass to Python. Splitting would inflate code without improving clarity.
import path from 'node:path';
import fs from 'fs-extra';
import { findProjectRoot, projectPaths, readPackageVersion } from '../lib/paths.js';
import { loadConfig, TIERS } from '../lib/config.js';
import { resolveTarget } from '../lib/tier-resolver.js';
import { runPython } from '../lib/python.js';
import { remove as stateRemove, stateUri } from '../lib/state-store.js';
import { downloadState, uploadStateIfChanged, gitHeadSha } from '../lib/state-sync.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
// ─── Helpers shared across subcommands ──────────────────────────────────────
async function resolveContext(argv) {
    const root = argv['project-dir']
        ? path.resolve(argv['project-dir'])
        : (await findProjectRoot()) ?? null;
    if (!root) {
        throw new AgentqError('No agentq.config.yaml found in cwd or any parent directory.', 'Run `agentq init` first, or pass --project-dir.');
    }
    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const pp = projectPaths(root, cfg.project.package);
    const target = resolveTarget(cfg, argv.tier);
    if (!target.tier && !cfg.gitops?.enabled) {
        throw new AgentqError('`agentq state` requires GitOps mode.', 'Enable gitops in agentq.config.yaml (set gitops.enabled: true and populate tiers.*) or use the legacy `agentq deploy` flow.');
    }
    return { root, cfg, pp, target };
}
async function buildPyCommonArgs(cfg, target, root, stateLocalPath) {
    const args = [
        '--config-file', path.join(root, 'agentq.config.yaml'),
        '--state-file', stateLocalPath,
    ];
    if (target.tier)
        args.push('--tier', target.tier);
    const sha = await gitHeadSha(root);
    args.push('--source-sha', sha);
    args.push('--cli-version', await readPackageVersion());
    return args;
}
// ─── Subcommand handlers ────────────────────────────────────────────────────
async function handleShow(argv) {
    const { cfg, pp, target } = await resolveContext(argv);
    const { localPath, existed } = await downloadState(target);
    if (!existed) {
        log.info(`No state file at ${stateUri(target)} — this tier has never been deployed.`);
        return;
    }
    const args = await buildPyCommonArgs(cfg, target, pp.root, localPath);
    await runPython(pp, 'agentq_runtime.state', ['show', ...args]);
}
async function handleDiff(argv) {
    const { cfg, pp, target } = await resolveContext(argv);
    const { localPath } = await downloadState(target);
    const args = await buildPyCommonArgs(cfg, target, pp.root, localPath);
    if (argv.json)
        args.push('--json');
    try {
        await runPython(pp, 'agentq_runtime.state', ['diff', ...args]);
    }
    catch (err) {
        // Python returns 3 when drift is detected — surface as a deliberate
        // signal (Node exits with the same code).
        const code = err.exitCode;
        if (code === 3) {
            process.exitCode = 3;
            return;
        }
        throw err;
    }
}
async function handlePlan(argv) {
    const { cfg, pp, target } = await resolveContext(argv);
    const { localPath, generation } = await downloadState(target);
    const sha = await gitHeadSha(pp.root);
    const tierLabel = target.tier ?? 'legacy';
    const out = argv.out ?? path.join(pp.agentqDir, 'plans', `${tierLabel}-${sha.slice(0, 8)}.json`);
    await fs.ensureDir(path.dirname(out));
    const args = await buildPyCommonArgs(cfg, target, pp.root, localPath);
    args.push('--plan-out', out);
    if (generation != null)
        args.push('--state-generation', String(generation));
    await runPython(pp, 'agentq_runtime.state', ['plan', ...args]);
    log.success(`Plan written to ${out}`);
    log.raw(out); // print path on its own line so CI can capture it
}
async function handleApply(argv) {
    const { cfg, pp, target } = await resolveContext(argv);
    const planPath = path.resolve(argv.plan);
    if (!(await fs.pathExists(planPath))) {
        throw new AgentqError(`Plan file not found: ${planPath}`, 'Run `agentq state plan --tier <t>` first.');
    }
    const { localPath, generation, existed } = await downloadState(target);
    const args = await buildPyCommonArgs(cfg, target, pp.root, localPath);
    args.push('--plan', planPath);
    if (generation != null)
        args.push('--state-generation', String(generation));
    await runPython(pp, 'agentq_runtime.state', ['apply', ...args]);
    // Python wrote a new state to localPath. Upload with concurrency check.
    await uploadStateIfChanged(target, localPath, existed ? generation : null);
}
async function handleImport(argv) {
    const { cfg, pp, target } = await resolveContext(argv);
    const { localPath, generation, existed } = await downloadState(target);
    if (existed) {
        log.warn(`State already exists at ${stateUri(target)}. Import will overwrite it.`);
    }
    const args = await buildPyCommonArgs(cfg, target, pp.root, localPath);
    args.push('--resource-name', argv['resource-name']);
    if (argv['with-kb'])
        args.push('--with-kb');
    await runPython(pp, 'agentq_runtime.state', ['import', ...args]);
    await uploadStateIfChanged(target, localPath, existed ? generation : null);
}
async function handleRm(argv) {
    const { target } = await resolveContext(argv);
    if (!argv.yes) {
        throw new AgentqError(`Refusing to delete state at ${stateUri(target)} without --yes.`, 'This does NOT destroy the deployed engine; it only removes the state file. To destroy: `agentq destroy --tier <t> <resource>`.');
    }
    const removed = await stateRemove(target);
    if (removed) {
        log.success(`Deleted ${stateUri(target)}`);
    }
    else {
        log.info(`No state file at ${stateUri(target)} to delete.`);
    }
}
// ─── yargs group definition ─────────────────────────────────────────────────
export const stateCommand = {
    command: 'state <subcommand>',
    describe: 'Inspect / plan / apply per-tier deploy state (GitOps mode).',
    builder: (y) => y
        .command('show', 'Pretty-print the state file for a tier.', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS }), handleShow)
        .command('diff', 'Compare local source with remote state. Exits 3 when drift is detected.', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS })
        .option('json', { type: 'boolean', default: false }), handleDiff)
        .command('plan', 'Compute and persist a plan JSON for the next apply.', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS })
        .option('out', { type: 'string', describe: 'Plan output path. Default: .agentq/plans/<tier>-<sha8>.json' }), handlePlan)
        .command('apply', 'Execute a plan JSON. Aborts if state has changed since the plan was computed.', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS })
        .option('plan', { type: 'string', demandOption: true, describe: 'Path to plan.json.' }), handleApply)
        .command('import', 'Stamp an existing Reasoning Engine into the tier state file (migration path).', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS })
        .option('resource-name', { type: 'string', demandOption: true, describe: 'Full resource name of the existing engine.' })
        .option('with-kb', { type: 'boolean', default: true, describe: 'Also seed the state with current local KB files (default true).' }), handleImport)
        .command('rm', 'Delete the tier state file. Does NOT destroy the engine.', (yy) => yy
        .option('project-dir', { type: 'string' })
        .option('tier', { type: 'string', choices: TIERS })
        .option('yes', { type: 'boolean', alias: 'y', default: false }), handleRm)
        .demandCommand(1)
        .strict(),
    handler: () => { },
};
//# sourceMappingURL=state.js.map