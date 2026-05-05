// Single logging surface used by every command. Keeps output consistent and
// makes it trivial to add a --quiet / --json mode later (single point of change).
import chalk from 'chalk';

type Level = 'debug' | 'info' | 'success' | 'warn' | 'error';

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
  // Make the flag visible to child processes (Python, gcloud) without every
  // command having to thread it through.
  if (v) process.env.AGENTQ_VERBOSE = '1';
}

export function isVerbose(): boolean {
  return verbose;
}

function emit(level: Level, msg: string): void {
  const tag: Record<Level, string> = {
    debug:   chalk.gray('  ·'),
    info:    chalk.blue('  ›'),
    success: chalk.green('  ✓'),
    warn:    chalk.yellow('  ⚠'),
    error:   chalk.red('  ✗'),
  };
  if (level === 'debug' && !verbose) return;
  // stderr for warn+error so stdout stays parseable for `agentq list` etc.
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${tag[level]} ${msg}\n`);
}

export const log = {
  debug:   (m: string) => emit('debug', m),
  info:    (m: string) => emit('info', m),
  success: (m: string) => emit('success', m),
  warn:    (m: string) => emit('warn', m),
  error:   (m: string) => emit('error', m),
  raw:     (m: string) => process.stdout.write(`${m}\n`),
  banner:  (m: string) => process.stdout.write(`\n${chalk.bold(m)}\n\n`),
};
