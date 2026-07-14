// `agentq init` — interactive walkthrough.
// Composes lib/scaffolder + lib/config; this command's only job is gathering
// answers and assembling the template context. No filesystem ops here.
//
// GitOps support: when the user answers yes to "Enable GitOps?", we scaffold
// a v2 config (gitops + tiers blocks) plus a GitHub Actions workflow + ops
// docs. The legacy deployment block is still emitted for backwards-compat
// with non-GitOps tooling, but tier_resolver.ts always prefers tiers.* when
// gitops.enabled=true.
import path from 'node:path';
import { input, select, confirm, number } from '@inquirer/prompts';
import { Scaffolder } from '../lib/scaffolder.js';
import { AgentqConfigSchema, writeConfig, } from '../lib/config.js';
import { listProviders } from '../lib/kb-provider.js';
import { buildRuntimePackages } from '../lib/runtime-packages.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
function toSnakeCase(kebab) {
    return kebab.replace(/-/g, '_');
}
function defaultStagingBucket(project) {
    return `gs://${project}-agentq-staging`;
}
function defaultStateBucket(project) {
    return `gs://${project}-agentq-state`;
}
const DEFAULT_ACTIONS_REPO = 'HorizonMedia/agentq-actions';
const DEFAULT_ACTIONS_REF = 'v1';
async function gatherAnswers(args) {
    const projectName = args.name ?? await input({
        message: 'Project name (kebab-case)',
        validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || 'Use lowercase letters, digits, and hyphens. Must start with a letter.',
    });
    const description = await input({ message: 'One-line description', default: '' });
    const displayName = await input({
        message: 'Display name (shown in Agent Designer / AgentQ)',
        default: projectName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    });
    const packageName = await input({
        message: 'Python package name',
        default: toSnakeCase(projectName),
        validate: (v) => /^[a-z][a-z0-9_]*$/.test(v) || 'Use lowercase letters, digits, and underscores.',
    });
    const pattern = await select({
        message: 'Orchestration pattern',
        choices: [
            { value: 'single', name: 'single      — one LlmAgent (simplest)' },
            { value: 'multi', name: 'multi       — orchestrator LlmAgent + sub-agents (LLM routing)' },
            { value: 'sequential', name: 'sequential  — fixed-order pipeline (deterministic)' },
            { value: 'hybrid', name: 'hybrid      — orchestrator + a sequential sub-pipeline' },
        ],
    });
    let subAgents = 0;
    if (pattern === 'multi') {
        subAgents = (await number({ message: 'How many sub-agents?', default: 2, min: 1, max: 8 })) ?? 2;
    }
    else if (pattern === 'sequential') {
        subAgents = (await number({ message: 'How many pipeline stages?', default: 3, min: 2, max: 8 })) ?? 3;
    }
    else if (pattern === 'hybrid') {
        subAgents = (await number({ message: 'How many stages in the inner sequential pipeline?', default: 3, min: 2, max: 8 })) ?? 3;
    }
    const kbProvider = await select({
        message: 'Knowledge base',
        choices: [
            { value: 'none', name: 'none                     — no external knowledge' },
            { value: 'gemini-enterprise-search', name: 'gemini-enterprise-search — managed search datastore' },
        ],
    });
    let datastoreId = null;
    let kbBucket = null;
    let kbLocation = 'global';
    if (kbProvider === 'gemini-enterprise-search') {
        datastoreId = await input({
            message: 'Datastore ID (short)',
            default: `${projectName}-corpus`,
            validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || 'Use kebab-case.',
        });
        kbBucket = await input({
            message: 'GCS bucket name for source documents',
            default: `${projectName}-corpus`,
        });
        kbLocation = await input({ message: 'Datastore location', default: 'global' });
    }
    const gcpProject = await input({ message: 'GCP project ID (default tier — dev for GitOps)' });
    const location = await input({ message: 'Agent Engine region', default: 'us-central1' });
    if (location === 'global') {
        throw new AgentqError('Agent Engine requires a regional location, not "global".');
    }
    const stagingBucket = await input({
        message: 'Staging bucket (gs://…)',
        default: defaultStagingBucket(gcpProject),
        validate: (v) => v.startsWith('gs://') || 'Must start with gs://',
    });
    const model = await input({ message: 'Default Gemini model', default: 'gemini-2.5-flash' });
    const useServiceAccount = await confirm({
        message: 'Use a user-managed runtime service account at deploy time? (Skip if using GitOps — setup-cicd creates SAs per-tier.)',
        default: false,
    });
    const serviceAccount = useServiceAccount
        ? await input({ message: 'Runtime SA email', default: `agentq-runtime@${gcpProject}.iam.gserviceaccount.com` })
        : null;
    const obsLevel = await select({
        message: 'Observability level',
        choices: [
            { value: 'basic', name: 'basic     — tracing only' },
            { value: 'standard', name: 'standard  — tracing + structured logs (recommended)' },
            { value: 'advanced', name: 'advanced  — tracing + logs + token tracker' },
        ],
        default: 'standard',
    });
    const includeSampleTool = await confirm({
        message: 'Include a sample FunctionTool to copy from?',
        default: true,
    });
    const includeFileTools = await confirm({
        message: 'Include file-handling tools (list/read user-uploaded files in chat)?',
        default: true,
    });
    const gitopsEnabled = await confirm({
        message: 'Enable GitOps (deploy via GitHub Actions on dev/staging/main branches)?',
        default: true,
    });
    let gitops;
    if (gitopsEnabled) {
        const devGcp = await input({ message: 'Dev GCP project ID', default: gcpProject });
        const prodGcp = await input({ message: 'Prod GCP project ID (staging + prod tiers live here)', default: devGcp });
        const branchProd = await input({ message: 'Prod branch name', default: 'main' });
        const branchStaging = await input({ message: 'Staging branch name', default: 'staging' });
        const branchDev = await input({ message: 'Dev branch name', default: 'dev' });
        // Allow override via env so teams that have migrated agentq-actions to a
        // different org don't have to re-type the default every project.
        const repoDefault = process.env.AGENTQ_ACTIONS_REPO ?? DEFAULT_ACTIONS_REPO;
        const refDefault = process.env.AGENTQ_ACTIONS_REF ?? DEFAULT_ACTIONS_REF;
        const actionsRepo = await input({
            message: 'agentq-actions repo (org/repo) — must be pushed AND have a matching ref',
            default: repoDefault,
            validate: (v) => /^[^/]+\/[^/]+$/.test(v) || 'Must be in org/repo form.',
        });
        const actionsRef = await input({
            message: 'agentq-actions ref to pin (tag or branch; e.g. v1, v1.0.0)',
            default: refDefault,
        });
        gitops = {
            enabled: true,
            devGcp, prodGcp,
            branchDev, branchStaging, branchProd,
            suffixes: { dev: ' (dev)', staging: ' (staging)', prod: ' (prod)' },
            actionsRepo, actionsRef,
        };
    }
    else {
        gitops = {
            enabled: false,
            devGcp: gcpProject, prodGcp: gcpProject,
            branchDev: 'dev', branchStaging: 'staging', branchProd: 'main',
            suffixes: { dev: '', staging: '', prod: '' },
            actionsRepo: DEFAULT_ACTIONS_REPO, actionsRef: DEFAULT_ACTIONS_REF,
        };
    }
    return {
        projectName, packageName, description, displayName,
        pattern, subAgents,
        kbProvider, datastoreId, kbBucket, kbLocation,
        gcpProject, location, stagingBucket, model, serviceAccount,
        obsLevel, includeSampleTool, includeFileTools,
        gitops,
    };
}
function buildTiersBlock(a) {
    if (!a.gitops.enabled)
        return undefined;
    const mk = (tierName, gcp, suffix) => ({
        gcp_project: gcp,
        location: a.location,
        staging_bucket: `gs://${gcp}-agentq-staging`,
        state_bucket: defaultStateBucket(gcp),
        deployer_service_account: `agentq-deploy-${tierName}@${gcp}.iam.gserviceaccount.com`,
        runtime_service_account: `agentq-runtime-${tierName}@${gcp}.iam.gserviceaccount.com`,
        display_name_suffix: suffix,
        labels: { env: tierName, 'managed-by': 'agentq' },
        kb: a.kbProvider === 'gemini-enterprise-search' ? {
            datastore_id: `${a.projectName}-${tierName}-corpus`,
            bucket: `${a.projectName}-${tierName}-corpus`,
            location: a.kbLocation,
            allow_freeform_mutation: tierName === 'dev',
        } : {
            datastore_id: null, bucket: null,
            location: 'global', allow_freeform_mutation: tierName === 'dev',
        },
    });
    return {
        dev: mk('dev', a.gitops.devGcp, a.gitops.suffixes.dev),
        staging: mk('staging', a.gitops.prodGcp, a.gitops.suffixes.staging),
        prod: mk('prod', a.gitops.prodGcp, a.gitops.suffixes.prod),
    };
}
async function buildContext(answers) {
    const a = answers;
    const stages = Array.from({ length: a.subAgents }, (_, i) => ({
        index: i + 1,
        name: a.pattern === 'sequential' || a.pattern === 'hybrid' ? `stage_${i + 1}` : `agent_${i + 1}`,
        isFirst: i === 0,
        isLast: i === a.subAgents - 1,
    }));
    const tiers = buildTiersBlock(a);
    const gitops = a.gitops.enabled ? {
        enabled: true,
        default_tier: 'dev',
        branch_map: {
            dev: a.gitops.branchDev,
            staging: a.gitops.branchStaging,
            prod: a.gitops.branchProd,
        },
        state_path_template: 'agentq/{project_name}/{tier}/state.yaml',
    } : null;
    return {
        project: {
            name: a.projectName,
            package: a.packageName,
            description: a.description,
            display_name: a.displayName,
        },
        agent: {
            pattern: a.pattern,
            entry_module: `${a.packageName}.agent`,
            entry_symbol: 'root_agent',
            sub_agents: a.subAgents,
        },
        deployment: {
            gcp_project: a.gcpProject,
            location: a.location,
            staging_bucket: a.stagingBucket,
            service_account: a.serviceAccount,
        },
        runtime: {
            model: a.model,
            python_packages: buildRuntimePackages({
                kb: a.kbProvider, files: a.includeFileTools,
            }),
        },
        knowledge_base: {
            provider: a.kbProvider,
            datastore_id: a.datastoreId,
            bucket: a.kbBucket,
            location: a.kbLocation,
        },
        observability: { level: a.obsLevel, tracing: true },
        gitops,
        tiers,
        // Exposed to templates for ${variable} substitution.
        cicd: a.gitops.enabled ? {
            branch_dev: a.gitops.branchDev,
            branch_staging: a.gitops.branchStaging,
            branch_prod: a.gitops.branchProd,
            dev_gcp: a.gitops.devGcp,
            prod_gcp: a.gitops.prodGcp,
            dev_state_bucket: defaultStateBucket(a.gitops.devGcp),
            prod_state_bucket: defaultStateBucket(a.gitops.prodGcp),
            // WIF provider resource names carry the numeric project number, which
            // isn't known at scaffold time — setup-cicd prints it per GCP. The
            // workflow routes between these two by env (see agentq-deploy.yml).
            // When dev and prod share one GCP there's a single pool, so both slots
            // use the same placeholder → the user replaces it once.
            dev_wif_provider: 'REPLACE_ME_dev_gcp_wif_provider',
            prod_wif_provider: a.gitops.devGcp === a.gitops.prodGcp
                ? 'REPLACE_ME_dev_gcp_wif_provider'
                : 'REPLACE_ME_prod_gcp_wif_provider',
            actions_ref: `${a.gitops.actionsRepo}/.github/workflows/deploy.yml@${a.gitops.actionsRef}`,
        } : null,
        flags: {
            pattern_single: a.pattern === 'single',
            pattern_multi: a.pattern === 'multi',
            pattern_sequential: a.pattern === 'sequential',
            pattern_hybrid: a.pattern === 'hybrid',
            kb_enabled: a.kbProvider !== 'none',
            kb_vertex: a.kbProvider === 'gemini-enterprise-search',
            include_sample_tool: a.includeSampleTool,
            include_file_tools: a.includeFileTools,
            gitops_enabled: a.gitops.enabled,
            obs_basic: a.obsLevel === 'basic',
            obs_standard: a.obsLevel === 'standard',
            obs_advanced: a.obsLevel === 'advanced',
        },
        stages,
    };
}
export const initCommand = {
    command: 'init [name]',
    describe: 'Interactively scaffold a new AgentQ project.',
    builder: (y) => y.positional('name', { type: 'string', describe: 'Project name (kebab-case).' })
        .option('force', { type: 'boolean', default: false, describe: 'Overwrite the destination directory if non-empty.' })
        .option('yes', { type: 'boolean', default: false, alias: 'y', describe: '(Reserved.) Accept defaults non-interactively where possible.' }),
    handler: async (argv) => {
        log.banner('AgentQ — new project');
        const answers = await gatherAnswers(argv);
        const ctx = await buildContext(answers);
        const projectDir = path.join(process.cwd(), ctx.project.name);
        const sources = ['common', `patterns/${ctx.agent.pattern}`];
        const flags = ctx.flags;
        if (flags.include_file_tools)
            sources.push('features/file-tools');
        if (flags.gitops_enabled)
            sources.push('features/gitops');
        if (flags.kb_vertex) {
            const provider = listProviders().find((p) => p.id === 'gemini-enterprise-search');
            if (provider)
                sources.push(...provider.templateSources());
        }
        const scaffolder = new Scaffolder();
        const written = await scaffolder.run({
            destination: projectDir, context: ctx, sources, overwrite: argv.force,
        });
        // Build the canonical agentq.config.yaml via zod. v2 when GitOps enabled.
        const cfgInput = {
            schema_version: flags.gitops_enabled ? 2 : 1,
            project: ctx.project, agent: ctx.agent, deployment: ctx.deployment,
            runtime: ctx.runtime, knowledge_base: ctx.knowledge_base,
            observability: ctx.observability, hooks: { pre_deploy: null, post_deploy: null },
        };
        if (flags.gitops_enabled) {
            cfgInput.gitops = ctx.gitops;
            cfgInput.tiers = ctx.tiers;
        }
        const parsed = AgentqConfigSchema.parse(cfgInput);
        await writeConfig(path.join(projectDir, 'agentq.config.yaml'), parsed);
        log.success(`Created ${written.length} files at ${projectDir}`);
        log.raw('');
        log.raw('Next steps:');
        log.raw(`  cd ${ctx.project.name}`);
        log.raw('  cp .env.example .env       # fill in any blank values');
        log.raw('  agentq doctor              # verify auth, APIs, config');
        if (flags.gitops_enabled) {
            log.raw('');
            log.raw('GitOps bootstrap (run ONCE per GCP project, by an ops user):');
            const cicd = ctx.cicd;
            log.raw(`  agentq setup-cicd --gcp-project ${cicd.dev_gcp}  --github-org <ORG> --github-repo <REPO> --tiers dev`);
            if (cicd.prod_gcp !== cicd.dev_gcp) {
                log.raw(`  agentq setup-cicd --gcp-project ${cicd.prod_gcp} --github-org <ORG> --github-repo <REPO> --tiers staging --tiers prod`);
            }
            log.raw('');
            log.raw('Then push to the dev branch — the workflow takes over from there.');
            log.raw('See docs/CICD_SETUP.md for the full ops checklist.');
        }
        else {
            if (ctx.flags.kb_enabled) {
                log.raw('  agentq kb create-bucket && agentq kb upload && agentq kb create-datastore && agentq kb import');
            }
            log.raw('  agentq deploy              # creates the Reasoning Engine');
        }
        log.raw('');
    },
};
//# sourceMappingURL=init.js.map