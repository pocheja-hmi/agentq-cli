// Entry point. Wires commands into yargs, owns global error handling, owns
// CLI-wide flags. The Open/Closed point of the codebase: adding a command
// means importing one new module here.
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { initCommand } from './commands/init.js';
import { newCommand } from './commands/new.js';
import { deployCommand } from './commands/deploy.js';
import { listCommand } from './commands/list.js';
import { destroyCommand } from './commands/destroy.js';
import { logsCommand } from './commands/logs.js';
import { doctorCommand } from './commands/doctor.js';
import { kbCommand } from './commands/kb.js';

import { setVerbose, log } from './lib/logger.js';
import { AgentqError } from './lib/errors.js';
import { readPackageVersion } from './lib/paths.js';

// Side-effect imports register concrete providers with the KBProvider registry.
import './providers/vertex-ai-search.js';

async function main(): Promise<void> {
  const version = await readPackageVersion();

  await yargs(hideBin(process.argv))
    .scriptName('agentq')
    .usage('$0 <command> [args]')
    .version(version)
    .option('verbose', { type: 'boolean', default: false, global: true, describe: 'Verbose logs.' })
    .middleware((argv) => { setVerbose(Boolean(argv.verbose)); })
    .command(initCommand)
    .command(newCommand)
    .command(deployCommand)
    .command(listCommand)
    .command(destroyCommand)
    .command(logsCommand)
    .command(doctorCommand)
    .command(kbCommand)
    .demandCommand(1, 'Specify a command. Run `agentq --help` for the list.')
    .strict()
    .recommendCommands()
    .help('help').alias('help', 'h')
    .epilog('Docs: https://github.com/pocheja-hmi/agentq-cli  (set AGENTQ_CLI_REPO env to override.)')
    .fail((msg, err) => {
      if (err instanceof AgentqError) {
        log.error(err.message);
        if (err.hint) log.warn(err.hint);
        process.exit(1);
      }
      if (err) {
        log.error(err.message || String(err));
        if (process.env.AGENTQ_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(err.stack);
        }
        process.exit(1);
      }
      log.error(msg ?? 'Unknown error');
      process.exit(1);
    })
    .parseAsync();
}

main().catch((err) => {
  if (err instanceof AgentqError) {
    log.error(err.message);
    if (err.hint) log.warn(err.hint);
    process.exit(1);
  }
  log.error((err as Error).message ?? String(err));
  if (process.env.AGENTQ_DEBUG) {
    // eslint-disable-next-line no-console
    console.error((err as Error).stack);
  }
  process.exit(1);
});
