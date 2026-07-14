// `agentq verify-secrets --tier <t>` — preflight that every *_SECRET_REF in
// runtime.env_vars is actually readable by the tier's runtime SA, in the
// tier's own GCP project. Designed to run in CI right before apply so a
// missing secret / missing accessor fails the deploy instead of surfacing as
// a broken integration at runtime.
//
// It tests the REAL runtime path by impersonating the runtime SA (the deploy
// SA is granted roles/iam.serviceAccountTokenCreator on it by setup-cicd), so
// it needs no Secret Manager permissions on the CI identity itself. Use
// --no-impersonate to test as the caller (for local ops with direct access).
//
// Complements `agentq doctor --tier <t>`, which does the same check via an
// IAM-policy read (better for a human ops user with broad read perms).
import path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { resolveTarget } from '../lib/tier-resolver.js';
import { gcloud } from '../lib/gcp.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  tier?: string;
  'project-dir'?: string;
  impersonate: boolean;
}

/** Substitute {project} in a secret ref with the tier's project. */
function expandRef(ref: string, project: string): string {
  return ref.split('{project}').join(project);
}

/** Extract secret name + version from projects/<p>/secrets/<n>/versions/<v>. */
function parseRef(ref: string): { name: string; version: string } | null {
  const m = ref.match(/secrets\/([^/]+)\/versions\/([^/]+)/);
  return m ? { name: m[1], version: m[2] } : null;
}

export const verifySecretsCommand: CommandModule<{}, Args> = {
  command: 'verify-secrets',
  describe: 'Verify each *_SECRET_REF is readable by the tier runtime SA (CI + pre-deploy preflight).',
  builder: (y: Argv) =>
    y.option('tier', { type: 'string', describe: 'Tier to verify (dev|staging|prod). Defaults to the gitops default tier.' })
     .option('project-dir', { type: 'string' })
     .option('impersonate', { type: 'boolean', default: true, describe: 'Test as the runtime SA (impersonation). --no-impersonate tests as the caller.' }) as Argv<Args>,
  handler: async (argv) => {
    const root = argv['project-dir'] ? path.resolve(argv['project-dir']) : (await findProjectRoot());
    if (!root) throw new AgentqError('Not in an AgentQ project (no agentq.config.yaml found).');

    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const target = resolveTarget(cfg, argv.tier);
    const project = target.gcp_project;
    const runtimeSa = target.runtime_service_account;

    const refs = Object.entries((cfg.runtime.env_vars ?? {}) as Record<string, string>)
      .filter(([k]) => k.endsWith('_SECRET_REF'));

    if (refs.length === 0) {
      log.success('No *_SECRET_REF entries in runtime.env_vars — nothing to verify.');
      return;
    }
    if (argv.impersonate && !runtimeSa) {
      throw new AgentqError(
        `No runtime_service_account for tier '${target.tier ?? 'default'}' — cannot verify secret access.`,
        'Set tiers.<t>.runtime_service_account, or run with --no-impersonate.',
      );
    }

    log.banner(`verify-secrets — tier ${target.tier ?? '(legacy)'} → ${project}`);
    if (argv.impersonate) log.info(`Testing as runtime SA: ${runtimeSa}`);

    const failures: string[] = [];
    for (const [key, rawRef] of refs) {
      const ref = expandRef(rawRef, project);
      const parsed = parseRef(ref);
      if (!parsed) {
        failures.push(`${key}: ref is not a valid Secret Manager path: ${ref}`);
        continue;
      }
      const args = [
        'secrets', 'versions', 'access', parsed.version,
        `--secret=${parsed.name}`,
        `--project=${project}`,
      ];
      if (argv.impersonate && runtimeSa) args.push(`--impersonate-service-account=${runtimeSa}`);
      try {
        await gcloud(args);
        log.success(`${key} → ${parsed.name} (${project}) readable`);
      } catch (err) {
        const raw = (err as { stderr?: string; message?: string }).stderr
          || (err as Error).message || 'unknown error';
        // Surface the real error, not gcloud's impersonation WARNING banner.
        const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        const msg = lines.find((l) => l.startsWith('ERROR:'))
          ?? lines.find((l) => !l.startsWith('WARNING:'))
          ?? lines[0] ?? 'unknown error';
        failures.push(`${key} → ${parsed.name} (${project}): ${msg}`);
      }
    }

    if (failures.length > 0) {
      for (const f of failures) log.error(f);
      throw new AgentqError(
        `${failures.length} secret(s) not readable by the ${target.tier ?? 'target'} runtime SA.`,
        `Provision per GCP: agentq setup-cicd --gcp-project ${project} ... --secret <name>, then add the value. ` +
        `Each secret must exist in ${project} with ${runtimeSa ?? 'the runtime SA'} granted roles/secretmanager.secretAccessor.`,
      );
    }
    log.success(`All ${refs.length} secret(s) readable.`);
  },
};
