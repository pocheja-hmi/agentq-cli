// `agentq deploy` — central deployment.
// All Vertex SDK work happens in the bundled Python runtime; this command's
// job is to: locate the project, validate config, ensure venv, dispatch.
import path from 'node:path';
import fs from 'fs-extra';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { runPython } from '../lib/python.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  'project-dir'?: string;
  update: boolean;
  recreate: boolean;
  'resource-name'?: string;
  reinstall: boolean;
}

export const deployCommand: CommandModule<{}, Args> = {
  command: 'deploy',
  describe: 'Create or update the Reasoning Engine for this project.',
  builder: (y: Argv) =>
    y.option('project-dir',  { type: 'string', describe: 'Project root (defaults to walk-up from cwd).' })
     .option('update',       { type: 'boolean', default: false, describe: 'Force update mode (auto-detected from agentq.config.yaml otherwise).' })
     .option('recreate',     { type: 'boolean', default: false, describe: 'Force creation of a NEW Reasoning Engine even if one is already persisted in agentq.config.yaml. The previous resource is left in place — run `agentq destroy <old>` to clean up if needed.' })
     .option('resource-name', { type: 'string', describe: 'Override deployment.resource_name from the config.' })
     .option('reinstall',    { type: 'boolean', default: false, describe: 'Recreate the .agentq Python venv before deploying.' })
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

    const args = [path.join(pp.root, 'agentq.config.yaml')];
    const explicitUpdate = argv.update || (cfg.deployment.resource_name != null);
    args.push(explicitUpdate ? '--update' : '--create');
    if (argv['resource-name']) args.push('--resource-name', argv['resource-name']);

    log.banner(`Deploying ${cfg.project.display_name}`);
    log.info(`mode: ${explicitUpdate ? 'update' : 'create'}`);
    log.info(`project: ${cfg.deployment.gcp_project}`);
    log.info(`location: ${cfg.deployment.location}`);
    log.info(`staging_bucket: ${cfg.deployment.staging_bucket}`);

    if (argv.reinstall) {
      const stamp = path.join(pp.agentqDir, 'venv.requirements.lock');
      if (await fs.pathExists(stamp)) await fs.remove(stamp);
    }

    await runPython(pp, 'agentq_runtime.deploy', args);
    log.success('Deploy completed.');
  },
};
