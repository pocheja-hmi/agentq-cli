// `agentq new <pattern> [name]` — non-interactive scaffold.
// Same composition as init, but answers come from flags. Useful for CI/scripts.
import path from 'node:path';
import { Scaffolder } from '../lib/scaffolder.js';
import { AgentqConfigSchema, writeConfig, PATTERNS, KB_PROVIDERS, } from '../lib/config.js';
import { listProviders } from '../lib/kb-provider.js';
import { buildRuntimePackages } from '../lib/runtime-packages.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';
export const newCommand = {
    command: 'new <pattern> <name>',
    describe: 'Non-interactive scaffold (everything via flags).',
    builder: (y) => y.positional('pattern', { describe: 'Orchestration pattern.', choices: PATTERNS })
        .positional('name', { describe: 'Project name (kebab-case).', type: 'string' })
        .option('pkg', { type: 'string', describe: 'Python package name (defaults to name with - → _).' })
        .option('gcp-project', { type: 'string', demandOption: true })
        .option('location', { type: 'string', default: 'us-central1' })
        .option('staging-bucket', { type: 'string', demandOption: true, describe: 'gs://… bucket for deploy staging.' })
        .option('model', { type: 'string', default: 'gemini-2.5-flash' })
        .option('kb', { type: 'string', choices: KB_PROVIDERS, default: 'none' })
        .option('datastore-id', { type: 'string' })
        .option('kb-bucket', { type: 'string' })
        .option('sub-agents', { type: 'number', default: 0 })
        .option('files', { type: 'boolean', default: true, describe: 'Include file-handling tools (read uploaded files in chat).' })
        .option('no-sample-tool', { type: 'boolean', default: false, describe: 'Skip the illustrative echo_tool example.' })
        .option('gitops', { type: 'boolean', default: false, describe: 'Scaffold GitOps (GitHub Actions workflow + tiers in agentq.config.yaml).' })
        .option('dev-gcp-project', { type: 'string', describe: 'Dev GCP project (defaults to --gcp-project).' })
        .option('prod-gcp-project', { type: 'string', describe: 'Prod GCP project (defaults to --gcp-project).' })
        .option('prod-branch', { type: 'string', default: 'main' })
        .option('staging-branch', { type: 'string', default: 'staging' })
        .option('dev-branch', { type: 'string', default: 'dev' })
        .option('actions-repo', { type: 'string', default: process.env.AGENTQ_ACTIONS_REPO ?? 'HorizonMedia/agentq-actions', describe: 'org/repo of agentq-actions to call (e.g. HorizonMedia/agentq-actions). Also reads AGENTQ_ACTIONS_REPO env.' })
        .option('actions-ref', { type: 'string', default: process.env.AGENTQ_ACTIONS_REF ?? 'v1', describe: 'Git ref on agentq-actions (tag or branch). Default v1.' })
        .option('force', { type: 'boolean', default: false }),
    handler: async (argv) => {
        const pattern = argv.pattern;
        if (!PATTERNS.includes(pattern)) {
            throw new AgentqError(`Unknown pattern: ${pattern}`);
        }
        const projectName = argv.name;
        const packageName = argv.pkg ?? projectName.replace(/-/g, '_');
        const subAgents = argv['sub-agents']
            || (pattern === 'sequential' || pattern === 'hybrid' ? 3 : pattern === 'multi' ? 2 : 0);
        const kbProvider = argv.kb;
        if (kbProvider === 'gemini-enterprise-search' && !argv['datastore-id']) {
            throw new AgentqError('--datastore-id is required when --kb=gemini-enterprise-search.');
        }
        const stages = Array.from({ length: subAgents }, (_, i) => ({
            index: i + 1,
            name: pattern === 'sequential' || pattern === 'hybrid' ? `stage_${i + 1}` : `agent_${i + 1}`,
            isFirst: i === 0,
            isLast: i === subAgents - 1,
        }));
        const devGcp = argv['dev-gcp-project'] ?? argv['gcp-project'];
        const prodGcp = argv['prod-gcp-project'] ?? argv['gcp-project'];
        const tiers = argv.gitops ? {
            dev: {
                gcp_project: devGcp,
                location: argv.location,
                staging_bucket: `gs://${devGcp}-agentq-staging`,
                state_bucket: `gs://${devGcp}-agentq-state`,
                deployer_service_account: `agentq-deploy-dev@${devGcp}.iam.gserviceaccount.com`,
                runtime_service_account: `agentq-runtime-dev@${devGcp}.iam.gserviceaccount.com`,
                display_name_suffix: ' (dev)',
                labels: { env: 'dev', 'managed-by': 'agentq' },
                kb: {
                    datastore_id: kbProvider === 'gemini-enterprise-search' ? `${projectName}-dev-corpus` : null,
                    bucket: kbProvider === 'gemini-enterprise-search' ? `${projectName}-dev-corpus` : null,
                    location: 'global', allow_freeform_mutation: true,
                },
            },
            staging: {
                gcp_project: prodGcp,
                location: argv.location,
                staging_bucket: `gs://${prodGcp}-agentq-staging`,
                state_bucket: `gs://${prodGcp}-agentq-state`,
                deployer_service_account: `agentq-deploy-staging@${prodGcp}.iam.gserviceaccount.com`,
                runtime_service_account: `agentq-runtime-staging@${prodGcp}.iam.gserviceaccount.com`,
                display_name_suffix: ' (staging)',
                labels: { env: 'staging', 'managed-by': 'agentq' },
                kb: {
                    datastore_id: kbProvider === 'gemini-enterprise-search' ? `${projectName}-staging-corpus` : null,
                    bucket: kbProvider === 'gemini-enterprise-search' ? `${projectName}-staging-corpus` : null,
                    location: 'global', allow_freeform_mutation: false,
                },
            },
            prod: {
                gcp_project: prodGcp,
                location: argv.location,
                staging_bucket: `gs://${prodGcp}-agentq-staging`,
                state_bucket: `gs://${prodGcp}-agentq-state`,
                deployer_service_account: `agentq-deploy-prod@${prodGcp}.iam.gserviceaccount.com`,
                runtime_service_account: `agentq-runtime-prod@${prodGcp}.iam.gserviceaccount.com`,
                display_name_suffix: ' (prod)',
                labels: { env: 'prod', 'managed-by': 'agentq' },
                kb: {
                    datastore_id: kbProvider === 'gemini-enterprise-search' ? `${projectName}-prod-corpus` : null,
                    bucket: kbProvider === 'gemini-enterprise-search' ? `${projectName}-prod-corpus` : null,
                    location: 'global', allow_freeform_mutation: false,
                },
            },
        } : undefined;
        const gitops = argv.gitops ? {
            enabled: true, default_tier: 'dev',
            branch_map: { dev: argv['dev-branch'], staging: argv['staging-branch'], prod: argv['prod-branch'] },
            state_path_template: 'agentq/{project_name}/{tier}/state.yaml',
        } : undefined;
        const ctx = {
            project: {
                name: projectName, package: packageName, description: '',
                display_name: projectName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            },
            agent: {
                pattern, entry_module: `${packageName}.agent`,
                entry_symbol: 'root_agent', sub_agents: subAgents,
            },
            deployment: {
                gcp_project: argv['gcp-project'], location: argv.location,
                staging_bucket: argv['staging-bucket'], service_account: null,
            },
            runtime: {
                model: argv.model,
                python_packages: buildRuntimePackages({
                    kb: kbProvider, files: argv.files,
                }),
            },
            knowledge_base: {
                provider: kbProvider,
                datastore_id: argv['datastore-id'] ?? null,
                bucket: argv['kb-bucket'] ?? null,
                location: 'global',
            },
            observability: { level: 'standard', tracing: true },
            gitops, tiers,
            cicd: argv.gitops ? {
                branch_dev: argv['dev-branch'],
                branch_staging: argv['staging-branch'],
                branch_prod: argv['prod-branch'],
                dev_gcp: devGcp,
                prod_gcp: prodGcp,
                dev_state_bucket: `gs://${devGcp}-agentq-state`,
                prod_state_bucket: `gs://${prodGcp}-agentq-state`,
                // WIF provider resource names carry the numeric project number, which
                // isn't known at scaffold time — setup-cicd prints it per GCP. The
                // workflow routes between these two by env (see agentq-deploy.yml).
                // When dev and prod share one GCP there's a single pool, so both
                // slots use the same placeholder → the user replaces it once.
                dev_wif_provider: 'REPLACE_ME_dev_gcp_wif_provider',
                prod_wif_provider: devGcp === prodGcp
                    ? 'REPLACE_ME_dev_gcp_wif_provider'
                    : 'REPLACE_ME_prod_gcp_wif_provider',
                actions_ref: `${argv['actions-repo']}/.github/workflows/deploy.yml@${argv['actions-ref']}`,
            } : null,
            flags: {
                pattern_single: pattern === 'single',
                pattern_multi: pattern === 'multi',
                pattern_sequential: pattern === 'sequential',
                pattern_hybrid: pattern === 'hybrid',
                kb_enabled: kbProvider !== 'none',
                kb_vertex: kbProvider === 'gemini-enterprise-search',
                include_sample_tool: !argv['no-sample-tool'],
                include_file_tools: argv.files,
                gitops_enabled: argv.gitops,
                obs_basic: false, obs_standard: true, obs_advanced: false,
            },
            stages,
        };
        const projectDir = path.join(process.cwd(), projectName);
        const sources = ['common', `patterns/${pattern}`];
        if (argv.files)
            sources.push('features/file-tools');
        if (argv.gitops)
            sources.push('features/gitops');
        if (kbProvider === 'gemini-enterprise-search') {
            const provider = listProviders().find((p) => p.id === 'gemini-enterprise-search');
            if (provider)
                sources.push(...provider.templateSources());
        }
        const scaffolder = new Scaffolder();
        const written = await scaffolder.run({
            destination: projectDir, context: ctx, sources, overwrite: argv.force,
        });
        const cfgInput = {
            schema_version: argv.gitops ? 2 : 1,
            project: ctx.project, agent: ctx.agent, deployment: ctx.deployment,
            runtime: ctx.runtime, knowledge_base: ctx.knowledge_base,
            observability: ctx.observability, hooks: { pre_deploy: null, post_deploy: null },
        };
        if (argv.gitops) {
            cfgInput.gitops = ctx.gitops;
            cfgInput.tiers = ctx.tiers;
        }
        const parsed = AgentqConfigSchema.parse(cfgInput);
        await writeConfig(path.join(projectDir, 'agentq.config.yaml'), parsed);
        log.success(`Created ${written.length} files at ${projectDir}`);
    },
};
//# sourceMappingURL=new.js.map