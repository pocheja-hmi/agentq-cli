// Resolves filesystem locations the CLI cares about.
// Centralising this means: never construct paths ad-hoc in commands.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// dist/lib/paths.js → ../../   = the package root
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

export const paths = {
  packageRoot: PACKAGE_ROOT,
  templates:   path.join(PACKAGE_ROOT, 'templates'),
  pythonRuntime: path.join(PACKAGE_ROOT, 'python'),
  packageJson: path.join(PACKAGE_ROOT, 'package.json'),
};

export interface ProjectPaths {
  root: string;
  configFile: string;
  agentqDir: string;     // .agentq/ — venv, cache, deploy state
  venv: string;
  packageDir: string;    // src/<pkg>/
  scriptsDir: string;
}

export function projectPaths(root: string, packageName: string): ProjectPaths {
  return {
    root,
    configFile: path.join(root, 'agentq.config.yaml'),
    agentqDir:  path.join(root, '.agentq'),
    venv:       path.join(root, '.agentq', 'venv'),
    packageDir: path.join(root, 'src', packageName),
    scriptsDir: path.join(root, 'scripts'),
  };
}

/** Walk up from cwd looking for agentq.config.yaml. */
export async function findProjectRoot(start: string = process.cwd()): Promise<string | null> {
  let dir = path.resolve(start);
  // Cap at filesystem root.
  while (true) {
    const cfg = path.join(dir, 'agentq.config.yaml');
    if (await fs.pathExists(cfg)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function readPackageVersion(): Promise<string> {
  const pkg = await fs.readJson(paths.packageJson);
  return pkg.version ?? '0.0.0';
}
