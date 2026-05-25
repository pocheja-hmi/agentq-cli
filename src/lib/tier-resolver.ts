// Single point of truth for "given this config + this --tier flag, what
// gcp_project / state_bucket / KB / SAs / labels apply?"
//
// Every command (deploy, destroy, kb, state, setup-cicd) flows through here.
// Commands NEVER reach into cfg.tiers[t] themselves — that would scatter the
// legacy/gitops coexistence rules across the codebase.
//
// Mirror: python/agentq_runtime/config.py::AgentqConfig.resolve_target(). The
// two implementations must agree on the same inputs. Drift between them =
// asymmetric deploy behavior.
import { AgentqError } from './errors.js';
import type { AgentqConfig, Tier, TierKbConfig } from './config.js';
import { TIERS } from './config.js';

export interface ResolvedTarget {
  /** null in legacy mode; the tier name otherwise. */
  tier: Tier | null;
  gcp_project: string;
  location: string;
  staging_bucket: string;
  /** null in legacy mode (state lives in agentq.config.yaml). */
  state_bucket: string | null;
  /** null in legacy mode. */
  deployer_service_account: string | null;
  /** What the deployed engine runs as. In legacy mode == cfg.deployment.service_account. */
  runtime_service_account: string | null;
  /** Composed: project.display_name + (tier ? display_name_suffix : ''). */
  display_name: string;
  labels: Record<string, string>;
  kb: TierKbConfig;
  /** Gemini Enterprise Search datastore resource path; null when KB not configured. */
  datastore_resource: string | null;
  /** Path inside the state bucket. null in legacy mode. */
  state_path: string | null;
}

function buildLegacyTarget(cfg: AgentqConfig): ResolvedTarget {
  return {
    tier: null,
    gcp_project: cfg.deployment.gcp_project,
    location: cfg.deployment.location,
    staging_bucket: cfg.deployment.staging_bucket,
    state_bucket: null,
    deployer_service_account: null,
    runtime_service_account: cfg.deployment.service_account,
    display_name: cfg.project.display_name,
    labels: {},
    kb: {
      datastore_id: cfg.knowledge_base.datastore_id,
      bucket: cfg.knowledge_base.bucket,
      location: cfg.knowledge_base.location,
      // Legacy mode is never gated — local kb mutations have always worked.
      allow_freeform_mutation: true,
    },
    datastore_resource: legacyDatastoreResource(cfg),
    state_path: null,
  };
}

function legacyDatastoreResource(cfg: AgentqConfig): string | null {
  const kb = cfg.knowledge_base;
  if (kb.provider !== 'gemini-enterprise-search' || !kb.datastore_id) return null;
  return `projects/${cfg.deployment.gcp_project}` +
         `/locations/${kb.location}` +
         `/collections/default_collection` +
         `/dataStores/${kb.datastore_id}`;
}

function buildTierTarget(cfg: AgentqConfig, tier: Tier): ResolvedTarget {
  if (!cfg.tiers || !cfg.tiers[tier]) {
    throw new AgentqError(
      `tiers.${tier} is not defined in agentq.config.yaml.`,
      `Define it under tiers.* or pick a tier that exists: ${Object.keys(cfg.tiers ?? {}).sort().join(', ') || '(none)'}`,
    );
  }
  const t = cfg.tiers[tier]!;
  const datastore_resource = t.kb.datastore_id
    ? `projects/${t.gcp_project}/locations/${t.kb.location}/collections/default_collection/dataStores/${t.kb.datastore_id}`
    : null;

  const template = cfg.gitops?.state_path_template ?? 'agentq/{project_name}/{tier}/state.yaml';
  const state_path = template
    .replace('{project_name}', cfg.project.name)
    .replace('{tier}', tier);

  return {
    tier,
    gcp_project: t.gcp_project,
    location: t.location,
    staging_bucket: t.staging_bucket,
    state_bucket: t.state_bucket,
    deployer_service_account: t.deployer_service_account,
    runtime_service_account: t.runtime_service_account,
    display_name: cfg.project.display_name + t.display_name_suffix,
    labels: { ...t.labels },
    kb: { ...t.kb },
    datastore_resource,
    state_path,
  };
}

function isTier(value: string | undefined | null): value is Tier {
  return value != null && (TIERS as readonly string[]).includes(value);
}

/**
 * Resolve a deploy target from a config + an optional --tier flag.
 *
 * Coexistence rules:
 *   1. tierFlag set       → use cfg.tiers[tierFlag]. Error if missing.
 *   2. gitops.enabled=true → use cfg.tiers[gitops.default_tier].
 *   3. otherwise           → use legacy cfg.deployment + cfg.knowledge_base.
 */
export function resolveTarget(cfg: AgentqConfig, tierFlag: string | undefined | null): ResolvedTarget {
  if (tierFlag != null) {
    if (!isTier(tierFlag)) {
      throw new AgentqError(
        `Unknown tier: ${JSON.stringify(tierFlag)}. Must be one of: ${TIERS.join(', ')}.`,
      );
    }
    return buildTierTarget(cfg, tierFlag);
  }
  if (cfg.gitops?.enabled) {
    const def = cfg.gitops.default_tier;
    if (!isTier(def)) {
      throw new AgentqError(`gitops.default_tier '${def}' is invalid. Must be one of: ${TIERS.join(', ')}.`);
    }
    return buildTierTarget(cfg, def);
  }
  return buildLegacyTarget(cfg);
}

/** Full state-file path within the state bucket. Throws in legacy mode. */
export function stateObjectPath(target: ResolvedTarget): string {
  if (!target.state_bucket || !target.state_path) {
    throw new AgentqError(
      'State path is only defined for tier targets.',
      'Use --tier to operate in tier mode, or update agentq.config.yaml with gitops.enabled=true and tiers.*.',
    );
  }
  return target.state_path;
}
