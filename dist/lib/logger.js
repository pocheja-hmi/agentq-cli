// Single logging surface used by every command. Keeps output consistent and
// makes it trivial to add a --quiet / --json mode later (single point of change).
import chalk from 'chalk';
let verbose = false;
export function setVerbose(v) {
    verbose = v;
    // Make the flag visible to child processes (Python, gcloud) without every
    // command having to thread it through.
    if (v)
        process.env.AGENTQ_VERBOSE = '1';
}
export function isVerbose() {
    return verbose;
}
function emit(level, msg) {
    const tag = {
        debug: chalk.gray('  ·'),
        info: chalk.blue('  ›'),
        success: chalk.green('  ✓'),
        warn: chalk.yellow('  ⚠'),
        error: chalk.red('  ✗'),
    };
    if (level === 'debug' && !verbose)
        return;
    // stderr for warn+error so stdout stays parseable for `agentq list` etc.
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${tag[level]} ${msg}\n`);
}
export const log = {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    success: (m) => emit('success', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    raw: (m) => process.stdout.write(`${m}\n`),
    banner: (m) => process.stdout.write(`\n${chalk.bold(m)}\n\n`),
};
//# sourceMappingURL=logger.js.map