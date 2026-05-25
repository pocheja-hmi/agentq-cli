// `agentq logs <resource>` — tail Cloud Logging for a deployed agent.
// Wraps `gcloud logging read` with a sane filter for Reasoning Engines.
import path from 'node:path';
import { execa } from 'execa';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
function engineIdFromResourceName(name) {
    const m = name.match(/reasoningEngines\/([\w-]+)/);
    if (!m)
        throw new AgentqError(`Resource name does not look like a Reasoning Engine: ${name}`);
    return m[1];
}
export const logsCommand = {
    command: 'logs <resource>',
    describe: 'Tail Cloud Logging entries for a deployed Reasoning Engine.',
    builder: (y) => y.positional('resource', { type: 'string', describe: 'Full Reasoning Engine resource name.' })
        .option('project-dir', { type: 'string' })
        .option('limit', { type: 'number', default: 50 })
        .option('follow', { type: 'boolean', alias: 'f', default: false, describe: 'Poll continuously.' })
        .option('freshness', { type: 'string', default: '1h', describe: 'How far back to read (e.g. 30m, 1h, 1d).' }),
    handler: async (argv) => {
        const root = argv['project-dir']
            ? path.resolve(argv['project-dir'])
            : (await findProjectRoot()) ?? null;
        if (!root) {
            throw new AgentqError('Run from inside an AgentQ project, or pass --project-dir.');
        }
        const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
        void projectPaths(root, cfg.project.package);
        const engineId = engineIdFromResourceName(argv.resource);
        const filter = [
            'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
            `resource.labels.reasoning_engine_id="${engineId}"`,
        ].join(' AND ');
        const baseArgs = [
            'logging', 'read', filter,
            `--project=${cfg.deployment.gcp_project}`,
            `--limit=${argv.limit}`,
            `--freshness=${argv.freshness}`,
            '--format=value(timestamp,severity,textPayload,jsonPayload.message)',
        ];
        do {
            log.info(`Reading last ${argv.limit} entries (freshness=${argv.freshness})`);
            try {
                await execa('gcloud', baseArgs, { stdio: 'inherit' });
            }
            catch (err) {
                const e = err;
                if (e.code === 'ENOENT') {
                    throw new AgentqError('gcloud not found.', 'Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install');
                }
                throw new AgentqError(`gcloud logging read failed: ${e.message ?? 'unknown error'}`);
            }
            if (argv.follow)
                await new Promise((r) => setTimeout(r, 5000));
        } while (argv.follow);
    },
};
//# sourceMappingURL=logs.js.map