// Single source of truth for what `agentq.config.yaml` looks like.
// Every command that reads the config goes through loadConfig() — schema
// validation happens in exactly one place (DRY) and the rest of the codebase
// works against a strongly-typed object (single responsibility per consumer).
//
// Schema versions:
//   1 — original layout (deployment.* + knowledge_base.* singletons).
//   2 — adds gitops.* and tiers.* for multi-tier GitOps deploys. The legacy
//       deployment/knowledge_base blocks remain optional for backwards compat;
//       gitops.enabled=true requires tiers.* to be populated.
import fs from 'fs-extra';
import YAML from 'yaml';
import { z } from 'zod';
import { AgentqError } from './errors.js';
export const PATTERNS = ['single', 'multi', 'sequential', 'hybrid'];
// Canonical KB provider ids. The string is what gets written into
// agentq.config.yaml and state.yaml. Old projects still have
// `provider: vertex-ai-search` in their YAML — `kbProviderField` accepts
// it as a legacy alias and normalises to the canonical name on load, so
// no migration step is required for existing teams.
export const KB_PROVIDERS = ['none', 'gemini-enterprise-search'];
// Legacy provider names that get rewritten to the canonical form on parse.
// Add new entries here when we deprecate-but-still-accept other names.
export const LEGACY_KB_PROVIDER_ALIASES = {
    'vertex-ai-search': 'gemini-enterprise-search',
};
/** A zod schema that accepts canonical KB provider names + legacy aliases,
 *  and always produces the canonical name after parsing. */
export const kbProviderField = z.preprocess((val) => (typeof val === 'string' && val in LEGACY_KB_PROVIDER_ALIASES
    ? LEGACY_KB_PROVIDER_ALIASES[val]
    : val), z.enum(KB_PROVIDERS));
export const OBSERVABILITY_LEVELS = ['basic', 'standard', 'advanced'];
export const TIERS = ['dev', 'staging', 'prod'];
const ProjectSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case'),
    package: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case'),
    description: z.string().default(''),
    display_name: z.string(),
});
const AgentSchema = z.object({
    pattern: z.enum(PATTERNS),
    entry_module: z.string(), // e.g. my_project.agent
    entry_symbol: z.string().default('root_agent'),
    sub_agents: z.number().int().min(0).max(10).default(0),
});
const DeploymentSchema = z.object({
    gcp_project: z.string(),
    location: z.string().default('us-central1'),
    staging_bucket: z.string().regex(/^gs:\/\//, 'must start with gs://'),
    service_account: z.string().nullable().default(null),
    resource_name: z.string().nullable().default(null),
});
const RuntimeSchema = z.object({
    model: z.string().default('gemini-2.5-flash'),
    python_packages: z.array(z.string()).default([
        'google-adk>=1.27.0',
        'google-genai>=1.0.0',
    ]),
    extra_packages: z.array(z.string()).default([]),
    env_vars: z.record(z.string()).default({}),
});
const KnowledgeBaseSchema = z.object({
    // Use kbProviderField so legacy `vertex-ai-search` rewrites to canonical.
    provider: kbProviderField.default('none'),
    datastore_id: z.string().nullable().default(null),
    bucket: z.string().nullable().default(null),
    location: z.string().default('global'),
});
const ObservabilitySchema = z.object({
    tracing: z.boolean().default(true),
    level: z.enum(OBSERVABILITY_LEVELS).default('standard'),
});
const HooksSchema = z.object({
    pre_deploy: z.string().nullable().default(null),
    post_deploy: z.string().nullable().default(null),
});
// ────────────────────────────────────────────────────────────────────────────
// GitOps additions (schema_version >= 2)
// ────────────────────────────────────────────────────────────────────────────
// Per-tier KB block. `allow_freeform_mutation: true` is the dev-tier default
// — it lets a developer run `agentq kb upload --tier dev` locally without
// passing --allow-prod-kb-mutation. Staging/prod default to false so the
// only path that mutates them is via GitOps merges.
const TierKbSchema = z.object({
    datastore_id: z.string().nullable().default(null),
    bucket: z.string().nullable().default(null),
    location: z.string().default('global'),
    allow_freeform_mutation: z.boolean().default(false),
});
const TierSchema = z.object({
    gcp_project: z.string(),
    location: z.string().default('us-central1'),
    staging_bucket: z.string().regex(/^gs:\/\//, 'must start with gs://'),
    state_bucket: z.string().regex(/^gs:\/\//, 'must start with gs://'),
    // Two SAs per tier (per locked design):
    //   deployer_service_account → what GitHub Actions impersonates via WIF.
    //   runtime_service_account  → what the deployed engine runs as.
    // Keeping the legacy `service_account` field name would conflate the two.
    deployer_service_account: z.string().nullable().default(null),
    runtime_service_account: z.string().nullable().default(null),
    display_name_suffix: z.string().default(''),
    labels: z.record(z.string()).default({}),
    kb: TierKbSchema.default({}),
});
const GitopsSchema = z.object({
    enabled: z.boolean().default(false),
    default_tier: z.enum(TIERS).default('dev'),
    branch_map: z.record(z.string()).default({ dev: 'dev', staging: 'staging', prod: 'main' }),
    state_path_template: z.string().default('agentq/{project_name}/{tier}/state.yaml'),
});
// ────────────────────────────────────────────────────────────────────────────
// Top-level config schema
// ────────────────────────────────────────────────────────────────────────────
export const AgentqConfigSchema = z.object({
    // Union accepts both versions; loadConfig() pre-processes v2 YAMLs to
    // synthesize a `deployment` block from the default tier when absent, so
    // every consumer of cfg.deployment.* keeps working unchanged.
    schema_version: z.union([z.literal(1), z.literal(2)]).default(2),
    project: ProjectSchema,
    agent: AgentSchema,
    deployment: DeploymentSchema,
    runtime: RuntimeSchema,
    knowledge_base: KnowledgeBaseSchema.default({}),
    observability: ObservabilitySchema.default({}),
    hooks: HooksSchema.default({}),
    // GitOps blocks — present only on v2 projects with GitOps enabled.
    gitops: GitopsSchema.optional(),
    tiers: z.record(z.enum(TIERS), TierSchema).optional(),
}).superRefine((cfg, ctx) => {
    // Invariant: if GitOps is enabled, tiers must be populated. We don't enforce
    // "all 3 tiers present" — teams may run dev-only initially — but we do
    // require at least one and the default_tier must exist in the map.
    if (cfg.gitops?.enabled) {
        if (!cfg.tiers || Object.keys(cfg.tiers).length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['tiers'],
                message: 'gitops.enabled=true requires `tiers:` block with at least one tier.',
            });
        }
        else if (!cfg.tiers[cfg.gitops.default_tier]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['gitops', 'default_tier'],
                message: `default_tier '${cfg.gitops.default_tier}' is not defined in tiers.*.`,
            });
        }
    }
});
/**
 * Pre-process raw YAML before schema validation. v2 GitOps projects MAY omit
 * the `deployment:` block (it's redundant when `tiers.*` is the source of
 * truth). We synthesize one from the default tier so the rest of the codebase
 * — which still reads `cfg.deployment.*` — keeps working unchanged. As
 * commands migrate to the tier-resolver, this synthesis becomes a no-op for
 * them; until then it's the compatibility shim.
 */
function synthesizeDeploymentFromTier(raw) {
    if (!raw || typeof raw !== 'object')
        return raw;
    if (raw.deployment)
        return raw;
    const gitops = raw.gitops;
    const tiers = raw.tiers;
    if (!gitops?.enabled || !tiers)
        return raw;
    const defaultTier = gitops.default_tier ?? 'dev';
    const tier = tiers[defaultTier];
    if (!tier)
        return raw;
    return {
        ...raw,
        deployment: {
            gcp_project: tier.gcp_project,
            location: tier.location ?? 'us-central1',
            staging_bucket: tier.staging_bucket,
            service_account: tier.runtime_service_account ?? null,
            resource_name: null,
        },
    };
}
export async function loadConfig(file) {
    if (!(await fs.pathExists(file))) {
        throw new AgentqError(`agentq.config.yaml not found at ${file}`, 'Run this command from inside an AgentQ project, or pass --project-dir.');
    }
    const raw = await fs.readFile(file, 'utf-8');
    let parsed;
    try {
        parsed = YAML.parse(raw);
    }
    catch (e) {
        throw new AgentqError(`Could not parse YAML: ${e.message}`);
    }
    parsed = synthesizeDeploymentFromTier(parsed);
    const result = AgentqConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new AgentqError(`Invalid agentq.config.yaml:\n${issues}`);
    }
    return result.data;
}
export async function writeConfig(file, cfg) {
    const yaml = YAML.stringify(cfg, { indent: 2, lineWidth: 100 });
    await fs.writeFile(file, yaml, 'utf-8');
}
//# sourceMappingURL=config.js.map