// `agentq kb <subcommand>` — knowledge-base management.
// Dispatches to whichever KBProvider the project has configured.
import path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { getProvider, listProviders } from '../lib/kb-provider.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  subcommand?: string;
  args?: string[];
  'project-dir'?: string;
}

export const kbCommand: CommandModule<{}, Args> = {
  command: 'kb [subcommand] [args..]',
  describe: 'Manage the knowledge base configured for this project.',
  builder: (y: Argv) =>
    y.positional('subcommand', { type: 'string', describe: 'KB subcommand (omit to see help).' })
     .positional('args', { type: 'string', array: true, describe: 'Arguments forwarded to the subcommand.' })
     .option('project-dir', { type: 'string' }) as Argv<Args>,
  handler: async (argv) => {
    const root = argv['project-dir']
      ? path.resolve(argv['project-dir'])
      : (await findProjectRoot()) ?? null;
    if (!root) {
      throw new AgentqError('Run from inside an AgentQ project, or pass --project-dir.');
    }
    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const pp = projectPaths(root, cfg.project.package);

    if (cfg.knowledge_base.provider === 'none') {
      throw new AgentqError(
        'This project was scaffolded without a knowledge base.',
        'Set knowledge_base.provider in agentq.config.yaml, then re-scaffold the KB templates.',
      );
    }

    const provider = getProvider(cfg.knowledge_base.provider);
    if (!provider) {
      const known = listProviders().map((p) => p.id).join(', ');
      throw new AgentqError(
        `Unknown KB provider: ${cfg.knowledge_base.provider}`,
        `Known providers: ${known}`,
      );
    }

    if (!argv.subcommand) {
      log.raw(provider.describe());
      return;
    }

    const subs = provider.subcommands({ projectPaths: pp, config: cfg });
    const handler = subs[argv.subcommand];
    if (!handler) {
      throw new AgentqError(
        `Unknown subcommand: ${argv.subcommand}`,
        `Available: ${Object.keys(subs).join(', ')}`,
      );
    }
    await handler(argv.args ?? []);
  },
};
