// Centralises Python invocation. The CLI ships a Python runtime alongside
// the TS code; commands that need it call ensureVenv() first, then runPython().
//
// One reason this exists: Agent Engine on Gemini Enterprise has no Node SDK. Deploying,
// listing, and destroying Reasoning Engines all require the python `vertexai`
// package. We isolate that here so the rest of the CLI stays Python-agnostic.
import path from 'node:path';
import fs from 'fs-extra';
import { execa, type Options as ExecaOptions } from 'execa';
import ora, { type Ora } from 'ora';
import { paths } from './paths.js';
import { ProjectPaths } from './paths.js';
import { log } from './logger.js';
import { AgentqError } from './errors.js';

// Local-venv requirements for the CLI's Python runtime (deploy / list / kb).
// Floors here matter:
// - aiplatform >= 1.95 avoids the `Logger.log_create_with_lro` AttributeError
//   that bit users on intermediate 1.7x/1.8x releases.
// - cloudpickle / pydantic must be present locally because AdkApp serialises
//   through cloudpickle during agent_engines.create().
const RUNTIME_REQUIREMENTS = [
  'google-cloud-aiplatform[agent_engines,adk]>=1.95.0',
  'google-adk>=1.27.0',
  'google-genai>=1.0.0',
  'google-cloud-discoveryengine>=0.13.0',
  'google-cloud-storage>=2.14.0',
  'pyyaml>=6.0',
  'cloudpickle>=3.0.0',
  'pydantic>=2.5.0',
];

export async function findSystemPython(): Promise<string> {
  for (const candidate of ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
    try {
      await execa(candidate, ['--version']);
      return candidate;
    } catch { /* try next */ }
  }
  throw new AgentqError(
    'No Python interpreter found on PATH.',
    'Install Python 3.10+ from https://www.python.org/ or via your package manager.',
  );
}

function venvPython(projectPaths: ProjectPaths): string {
  const isWin = process.platform === 'win32';
  return isWin
    ? path.join(projectPaths.venv, 'Scripts', 'python.exe')
    : path.join(projectPaths.venv, 'bin', 'python');
}

/**
 * Run a noisy command quietly behind a spinner. Output is buffered; only the
 * tail is dumped to the user if the command fails. Verbose mode streams in
 * realtime so debugging stays easy.
 */
async function runQuiet(
  spinnerText: string,
  cmd: string,
  args: string[],
  opts: { verbose: boolean; cwd?: string },
): Promise<void> {
  if (opts.verbose) {
    log.info(spinnerText);
    await execa(cmd, args, { stdio: 'inherit', cwd: opts.cwd });
    return;
  }

  const spinner: Ora = ora({ text: spinnerText, color: 'blue' }).start();
  const buffer: string[] = [];
  const child = execa(cmd, args, { cwd: opts.cwd, all: true, reject: false });

  child.all?.on('data', (chunk: Buffer) => {
    buffer.push(chunk.toString('utf-8'));
    // Keep the spinner from being silent on long installs — show the most
    // recent meaningful line as the spinner suffix.
    const lines = buffer.join('').split('\n').map((l) => l.trim()).filter(Boolean);
    const latest = lines[lines.length - 1];
    if (latest && latest.length < 80) {
      spinner.text = `${spinnerText} — ${latest}`;
    }
  });

  const result = await child;
  if (result.exitCode === 0) {
    spinner.succeed(spinnerText);
    return;
  }
  spinner.fail(spinnerText);
  // Only show the noisy output when something went wrong — keep it bounded.
  const tail = buffer.join('').split('\n').slice(-40).join('\n');
  process.stderr.write(tail + '\n');
  throw new AgentqError(
    `${cmd} failed with exit code ${result.exitCode ?? 'unknown'}.`,
    'Re-run with --verbose to see full output.',
  );
}

export async function ensureVenv(
  projectPaths: ProjectPaths,
  opts: { reinstall?: boolean; verbose?: boolean } = {},
): Promise<string> {
  const verbose = Boolean(opts.verbose) || Boolean(process.env.AGENTQ_VERBOSE);
  const py = venvPython(projectPaths);
  const exists = await fs.pathExists(py);
  if (!exists) {
    await fs.ensureDir(projectPaths.agentqDir);
    const sysPy = await findSystemPython();
    await runQuiet(
      `Creating Python venv at ${path.relative(process.cwd(), projectPaths.venv)}`,
      sysPy, ['-m', 'venv', projectPaths.venv],
      { verbose },
    );
  }

  const stamp = path.join(projectPaths.agentqDir, 'venv.requirements.lock');
  const desired = RUNTIME_REQUIREMENTS.join('\n');
  const current = (await fs.pathExists(stamp)) ? await fs.readFile(stamp, 'utf-8') : '';
  if (opts.reinstall || current !== desired) {
    await runQuiet(
      'Upgrading pip',
      py, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'],
      { verbose },
    );
    await runQuiet(
      'Installing Python runtime dependencies (one-time per project)',
      py, ['-m', 'pip', 'install', '--quiet', ...RUNTIME_REQUIREMENTS],
      { verbose },
    );
    await fs.writeFile(stamp, desired, 'utf-8');
  }
  return py;
}

export async function runPython(
  projectPaths: ProjectPaths,
  module: string,
  args: string[],
  options: ExecaOptions = {},
): Promise<void> {
  const verbose = Boolean(process.env.AGENTQ_VERBOSE);
  const py = await ensureVenv(projectPaths, { verbose });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: [paths.pythonRuntime, projectPaths.root, process.env.PYTHONPATH ?? '']
      .filter(Boolean).join(path.delimiter),
    // Suppress harmless SDK warnings unless caller opted into verbose.
    AGENTQ_QUIET: verbose ? '' : '1',
  };
  await execa(py, ['-m', module, ...args], {
    stdio: 'inherit',
    cwd: projectPaths.root,
    env,
    ...options,
  });
}
