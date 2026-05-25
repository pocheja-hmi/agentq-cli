// `agentq destroy <resource>` — delete a deployed Reasoning Engine.
//
// Behavior matrix:
//
//                    Default                         --purge
//   Legacy mode      Delete engine + force cascade   + delete gs://<staging>/agent_engine/*
//                    Clear resource_name from        (same as default)
//                    agentq.config.yaml
//
//   Tier mode (--tier given OR resource matches a    + delete the tier's staging bucket prefix
//   tier's state):  Delete engine + force cascade   (uses tier.staging_bucket)
//                    Delete the GCS state file
//                    (state.yaml for that tier)
//
// --purge controls GCS-staging cleanup only because staging buckets may be
// shared across AgentQ projects in the same GCP. State-file cleanup
// always happens — it's per-project, not shared.
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig, TIERS } from '../lib/config.js';
import { resolveTarget } from '../lib/tier-resolver.js';
import { read as stateRead, remove as stateRemove, stateUri } from '../lib/state-store.js';
import { runPython } from '../lib/python.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
export const destroyCommand = {
    command: 'destroy <resource>',
    describe: 'Delete a deployed Reasoning Engine and clear it from the config / state file.',
    builder: (y) => y.positional('resource', { type: 'string', describe: 'Full resource name (projects/.../reasoningEngines/...).' })
        .option('project-dir', { type: 'string', describe: 'Project root (defaults to walk-up from cwd).' })
        .option('tier', { type: 'string', choices: TIERS, describe: 'Tier the resource belongs to (state file will be deleted). Inferred from resource_name when omitted.' })
        .option('purge', { type: 'boolean', default: false, describe: 'Also delete staging artifacts from the project\'s staging bucket. May affect other AgentQ projects sharing the same bucket — use deliberately.' })
        .option('yes', { type: 'boolean', alias: 'y', default: false, describe: 'Skip the confirmation prompt.' }),
    handler: async (argv) => {
        const root = argv['project-dir']
            ? path.resolve(argv['project-dir'])
            : (await findProjectRoot()) ?? null;
        if (!root) {
            throw new AgentqError('Run from inside an AgentQ project, or pass --project-dir.');
        }
        const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
        const pp = projectPaths(root, cfg.project.package);
        // Determine if we're in tier mode. Either --tier was passed, or the
        // resource matches a tier's state.
        let tierMatch = argv.tier ?? null;
        if (!tierMatch && cfg.gitops?.enabled) {
            // Search each tier's state for a matching resource_name.
            for (const t of Object.keys(cfg.tiers ?? {})) {
                const target = resolveTarget(cfg, t);
                try {
                    const result = await stateRead(target);
                    if (result?.state.engine?.resource_name === argv.resource) {
                        tierMatch = t;
                        break;
                    }
                }
                catch {
                    // Skip tiers whose state buckets are unreachable (e.g. setup-cicd
                    // not yet run for that tier). Caller can pass --tier explicitly.
                }
            }
        }
        // Build the resolved target — affects which staging bucket we purge.
        const target = resolveTarget(cfg, tierMatch ?? undefined);
        const willClearLegacyConfig = !target.tier && cfg.deployment.resource_name === argv.resource;
        const willClearStateFile = target.tier !== null;
        if (!argv.yes) {
            const lines = [
                `Permanently delete ${argv.resource}?`,
                target.tier
                    ? `  · tier: ${target.tier}`
                    : null,
                willClearLegacyConfig
                    ? '  · Will also clear resource_name from agentq.config.yaml.'
                    : null,
                willClearStateFile
                    ? `  · Will also delete state file at ${stateUri(target)}.`
                    : null,
                argv.purge
                    ? `  · Will also delete staging artifacts from ${target.staging_bucket}/agent_engine/`
                    : null,
                'This cannot be undone.',
            ].filter(Boolean).join('\n');
            const ok = await confirm({ message: lines, default: false });
            if (!ok) {
                log.warn('Aborted.');
                return;
            }
        }
        // 1. Delete the engine via Python (handles force=True cascade + legacy
        //    resource_name clearing).
        const args = [argv.resource];
        if (argv.purge)
            args.push('--purge');
        args.push('--config-file', path.join(pp.root, 'agentq.config.yaml'));
        if (target.tier)
            args.push('--tier', target.tier);
        await runPython(pp, 'agentq_runtime.destroy', args);
        log.success('Engine deleted.');
        // 2. Delete the state file (tier mode only). Python doesn't do this
        //    because GCS state ownership is purely Node-side.
        if (willClearStateFile) {
            try {
                const removed = await stateRemove(target);
                if (removed) {
                    log.info(`Cleared state file at ${stateUri(target)}.`);
                }
            }
            catch (e) {
                log.warn(`Could not delete state file: ${e.message}`);
            }
        }
        if (willClearLegacyConfig)
            log.info('Cleared resource_name from agentq.config.yaml.');
        if (argv.purge)
            log.info('Purged staging artifacts.');
    },
};
//# sourceMappingURL=destroy.js.map