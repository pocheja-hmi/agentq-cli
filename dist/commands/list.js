// `agentq list` — list every Reasoning Engine in the configured GCP project.
import path from 'node:path';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { runPython } from '../lib/python.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
export const listCommand = {
    command: 'list',
    describe: 'List Reasoning Engines for the configured GCP project.',
    builder: (y) => y.option('project-dir', { type: 'string', describe: 'Project root (defaults to walk-up from cwd).' })
        .option('gcp-project', { type: 'string', describe: 'Override the GCP project ID from agentq.config.yaml.' })
        .option('location', { type: 'string', describe: 'Override the location.' })
        .option('json', { type: 'boolean', default: false }),
    handler: async (argv) => {
        const root = argv['project-dir']
            ? path.resolve(argv['project-dir'])
            : (await findProjectRoot()) ?? null;
        if (!root) {
            throw new AgentqError('No agentq.config.yaml found and no --project-dir given.', 'Run from inside an AgentQ project, or pass --gcp-project + --location with --project-dir.');
        }
        const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
        const pp = projectPaths(root, cfg.project.package);
        const gcpProject = argv['gcp-project'] ?? cfg.deployment.gcp_project;
        const location = argv.location ?? cfg.deployment.location;
        const args = ['--gcp-project', gcpProject, '--location', location];
        if (argv.json)
            args.push('--json');
        log.info(`Listing reasoning engines in ${gcpProject} / ${location}`);
        await runPython(pp, 'agentq_runtime.list_engines', args);
    },
};
//# sourceMappingURL=list.js.map