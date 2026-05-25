// Helpers for syncing the GCS state.yaml with a local working copy.
// Used by both `agentq state ...` and `agentq deploy --tier <t>` so the
// download/upload semantics are identical regardless of entry point.
//
// CONCURRENCY: every upload uses optimistic concurrency via the state object's
// GCS generation. If two CI runs deploy concurrently to the same tier, the
// second's `state.write` returns 412 → we surface ConcurrentDeployError with a
// "rerun plan + apply" hint. See state-store.ts for the GCS-level details.
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import YAML from 'yaml';
import { execa } from 'execa';
import { read as stateRead, write as stateWrite, stateUri } from './state-store.js';
import type { ResolvedTarget } from './tier-resolver.js';
import { log } from './logger.js';

export interface DownloadedState {
  /** Local filesystem path the Python runtime reads from. */
  localPath: string;
  /** GCS object generation we read at, or null if the object didn't exist. */
  generation: number | null;
  existed: boolean;
}

/** Download the tier's state.yaml from GCS to a temp file. */
export async function downloadState(target: ResolvedTarget): Promise<DownloadedState> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentq-state-'));
  const localPath = path.join(tmpDir, 'state.yaml');
  const result = await stateRead(target);
  if (result === null) {
    return { localPath, generation: null, existed: false };
  }
  await fs.writeFile(
    localPath,
    YAML.stringify(result.state, { indent: 2, lineWidth: 120 }),
    'utf-8',
  );
  return { localPath, generation: result.generation, existed: true };
}

/**
 * Upload a possibly-mutated local state file back to GCS. Uses optimistic
 * concurrency based on the generation we downloaded at.
 *
 * Returns `null` if the local file is missing or empty (apply didn't write
 * a new state — common when nothing changed).
 */
export async function uploadStateIfChanged(
  target: ResolvedTarget,
  localPath: string,
  expectedGeneration: number | null,
): Promise<{ generation: number } | null> {
  if (!(await fs.pathExists(localPath))) return null;
  const body = await fs.readFile(localPath, 'utf-8');
  if (!body.trim()) return null;
  const parsed = YAML.parse(body);
  if (!parsed) return null;
  const ifGenMatch = expectedGeneration === null ? 0 : expectedGeneration;
  const result = await stateWrite(target, parsed, ifGenMatch);
  log.success(`State updated → ${stateUri(target)} (generation ${result.generation})`);
  return result;
}

/** git HEAD SHA. Best-effort — returns 'unlocal' outside a git repo. */
export async function gitHeadSha(cwd: string): Promise<string> {
  try {
    const r = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    return r.stdout.trim();
  } catch {
    return 'unlocal';
  }
}
