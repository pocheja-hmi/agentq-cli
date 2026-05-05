// `agentq destroy <resource>` — delete a deployment.
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { runPython } from '../lib/python.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  resource: string;
  'project-dir'?: string;
  yes: boolean;
}

export const destroyCommand: CommandModule<{}, Args> = {
  command: 'destroy <resource>',
  describe: 'Delete a deployed Reasoning Engine.',
  builder: (y: Argv) =>
    y.positional('resource', { type: 'string', describe: 'Full resource name (projects/.../reasoningEngines/...).' })
     .option('project-dir', { type: 'string' })
     .option('yes',         { type: 'boolean', alias: 'y', default: false, describe: 'Skip the confirmation prompt.' }) as Argv<Args>,
  handler: async (argv) => {
    const root = argv['project-dir']
      ? path.resolve(argv['project-dir'])
      : (await findProjectRoot()) ?? null;
    if (!root) {
      throw new AgentqError('Run from inside an AgentQ project, or pass --project-dir.');
    }
    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const pp = projectPaths(root, cfg.project.package);

    if (!argv.yes) {
      const ok = await confirm({
        message: `Permanently delete ${argv.resource}? This cannot be undone.`,
        default: false,
      });
      if (!ok) {
        log.warn('Aborted.');
        return;
      }
    }
    await runPython(pp, 'agentq_runtime.destroy', [argv.resource]);
    log.success('Deleted.');
  },
};
