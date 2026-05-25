// `config_hash` is the single drift token.
//
// We hash a CANONICAL serialization of the subset of agentq.config.yaml that
// actually affects deployed shape. Any change to those fields produces a new
// hash → state.engine.config_hash mismatches → drift is detected → plan runs.
//
// Fields deliberately EXCLUDED:
//   - schema_version  (a YAML format detail, not a deploy concern)
//   - observability   (callbacks attached at runtime; not part of the engine spec)
//   - hooks           (project-local; the hook IMPLEMENTATION can mutate state but
//                      changing the *path* shouldn't trigger an engine update)
//   - history         (it's the audit log; not source intent)
//   - runtime_version (CLI version; this is metadata about who deployed,
//                      not what was deployed. Bumping the CLI shouldn't
//                      mark every deployed engine as drifted.)
//   - For the resolved env_vars block: KB_DATASTORE, MODEL, and
//     GOOGLE_GENAI_USE_VERTEXAI are auto-injected by config.py from the
//     same source values that ARE hashed (kb.datastore_id, runtime.model).
//     Including them would double-count, so they're stripped.
//
// The Python side has a mirror in agentq_runtime/config_hash.py. A unit test
// in tests/ feeds the same fixture into both and asserts identical output.
// If they diverge, drift detection becomes asymmetric and plan/apply
// behavior depends on which side computed the hash — a class of bug we want
// to prevent entirely.
import { createHash } from 'node:crypto';
import type { AgentqConfig } from './config.js';

const AUTO_INJECTED_ENV_KEYS = new Set([
  'MODEL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'KB_DATASTORE',
]);

/** Stable JSON serialization: keys sorted, nulls excluded, no whitespace. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || v === null) return null;
      return JSON.stringify(k) + ':' + canonical(v);
    }).filter((p) => p !== null);
    return '{' + parts.join(',') + '}';
  }
  // Functions, symbols, bigints — should never appear in our config.
  throw new Error(`canonical: unsupported value type ${typeof value}`);
}

/**
 * Build the "what we deployed" view of a config for hashing.
 *
 * For GitOps projects, `tier` selects which tiers.<t> branch to bake into
 * the hash. For legacy projects, `tier` is ignored and the legacy deployment
 * block is used.
 */
function deployedView(cfg: AgentqConfig, tier: string | null): Record<string, unknown> {
  const envClean: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.runtime.env_vars ?? {})) {
    if (AUTO_INJECTED_ENV_KEYS.has(k)) continue;
    envClean[k] = v;
  }

  let tierBlock: Record<string, unknown> | null = null;
  if (tier && cfg.tiers && cfg.tiers[tier as keyof typeof cfg.tiers]) {
    const t = cfg.tiers[tier as keyof typeof cfg.tiers]!;
    tierBlock = {
      gcp_project:        t.gcp_project,
      location:           t.location,
      runtime_service_account: t.runtime_service_account,
      display_name_suffix: t.display_name_suffix,
      labels:             t.labels,
      kb: {
        datastore_id: t.kb.datastore_id,
        bucket:       t.kb.bucket,
        location:     t.kb.location,
      },
    };
  }

  return {
    project: {
      name:         cfg.project.name,
      package:      cfg.project.package,
      display_name: cfg.project.display_name,
    },
    agent: {
      pattern:      cfg.agent.pattern,
      entry_module: cfg.agent.entry_module,
      entry_symbol: cfg.agent.entry_symbol,
      sub_agents:   cfg.agent.sub_agents,
    },
    runtime: {
      model:           cfg.runtime.model,
      python_packages: [...cfg.runtime.python_packages].sort(),
      extra_packages:  [...cfg.runtime.extra_packages].sort(),
      env_vars:        envClean,
    },
    tier,
    tier_block: tierBlock,
    legacy_deployment: tierBlock ? null : {
      gcp_project:     cfg.deployment.gcp_project,
      location:        cfg.deployment.location,
      service_account: cfg.deployment.service_account,
    },
    legacy_kb: tierBlock ? null : {
      provider:     cfg.knowledge_base.provider,
      datastore_id: cfg.knowledge_base.datastore_id,
      bucket:       cfg.knowledge_base.bucket,
      location:     cfg.knowledge_base.location,
    },
  };
}

/** Compute the sha256 drift token. Format: `sha256:<64-hex>`. */
export function computeConfigHash(cfg: AgentqConfig, tier: string | null): string {
  const view = deployedView(cfg, tier);
  const serial = canonical(view);
  const digest = createHash('sha256').update(serial, 'utf-8').digest('hex');
  return `sha256:${digest}`;
}

/**
 * Hash a sorted document set. Used for `kb.docset_hash` — the cheap top-level
 * "did the corpus change?" check before per-file diffing.
 */
export function computeDocsetHash(documents: Array<{ filename: string; sha256: string }>): string {
  const sorted = [...documents].sort((a, b) => a.filename.localeCompare(b.filename));
  const serial = canonical(sorted.map((d) => ({ filename: d.filename, sha256: d.sha256 })));
  const digest = createHash('sha256').update(serial, 'utf-8').digest('hex');
  return `sha256:${digest}`;
}
