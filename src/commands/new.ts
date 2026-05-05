// `agentq new <pattern> [name]` — non-interactive scaffold.
// Same composition as init, but answers come from flags. Useful for CI/scripts.
import path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import { Scaffolder } from '../lib/scaffolder.js';
import {
  AgentqConfigSchema, writeConfig, PATTERNS, KB_PROVIDERS,
  type Pattern, type KbProvider,
} from '../lib/config.js';
import { listProviders } from '../lib/kb-provider.js';
import { buildRuntimePackages } from '../lib/runtime-packages.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  pattern: string;
  name: string;
  pkg?: string;
  'gcp-project': string;
  location: string;
  'staging-bucket': string;
  model: string;
  kb: string;
  'datastore-id'?: string;
  'kb-bucket'?: string;
  'sub-agents': number;
  files: boolean;
  'no-sample-tool': boolean;
  force: boolean;
}

export const newCommand: CommandModule<{}, Args> = {
  command: 'new <pattern> <name>',
  describe: 'Non-interactive scaffold (everything via flags).',
  builder: (y: Argv) =>
    y.positional('pattern', { describe: 'Orchestration pattern.', choices: PATTERNS as readonly string[] })
     .positional('name', { describe: 'Project name (kebab-case).', type: 'string' })
     .option('pkg',            { type: 'string',  describe: 'Python package name (defaults to name with - → _).' })
     .option('gcp-project',    { type: 'string',  demandOption: true })
     .option('location',       { type: 'string',  default: 'us-central1' })
     .option('staging-bucket', { type: 'string',  demandOption: true, describe: 'gs://… bucket for deploy staging.' })
     .option('model',          { type: 'string',  default: 'gemini-2.5-flash' })
     .option('kb',             { type: 'string',  choices: KB_PROVIDERS as readonly string[], default: 'none' })
     .option('datastore-id',   { type: 'string' })
     .option('kb-bucket',      { type: 'string' })
     .option('sub-agents',     { type: 'number',  default: 0 })
     .option('files',          { type: 'boolean', default: true,  describe: 'Include file-handling tools (read uploaded files in chat).' })
     .option('no-sample-tool', { type: 'boolean', default: false, describe: 'Skip the illustrative echo_tool example.' })
     .option('force',          { type: 'boolean', default: false }) as Argv<Args>,
  handler: async (argv) => {
    const pattern = argv.pattern as Pattern;
    if (!(PATTERNS as readonly string[]).includes(pattern)) {
      throw new AgentqError(`Unknown pattern: ${pattern}`);
    }
    const projectName = argv.name;
    const packageName = argv.pkg ?? projectName.replace(/-/g, '_');
    const subAgents = argv['sub-agents']
      || (pattern === 'sequential' || pattern === 'hybrid' ? 3 : pattern === 'multi' ? 2 : 0);

    const kbProvider = argv.kb as KbProvider;
    if (kbProvider === 'vertex-ai-search' && !argv['datastore-id']) {
      throw new AgentqError('--datastore-id is required when --kb=vertex-ai-search.');
    }

    const stages = Array.from({ length: subAgents }, (_, i) => ({
      index: i + 1,
      name: pattern === 'sequential' || pattern === 'hybrid' ? `stage_${i + 1}` : `agent_${i + 1}`,
      isFirst: i === 0,
      isLast:  i === subAgents - 1,
    }));

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
      observability: { level: 'standard' as const, tracing: true },
      flags: {
        pattern_single:     pattern === 'single',
        pattern_multi:      pattern === 'multi',
        pattern_sequential: pattern === 'sequential',
        pattern_hybrid:     pattern === 'hybrid',
        kb_enabled:         kbProvider !== 'none',
        kb_vertex:          kbProvider === 'vertex-ai-search',
        include_sample_tool: !argv['no-sample-tool'],
        include_file_tools:  argv.files,
        obs_basic: false, obs_standard: true, obs_advanced: false,
      },
      stages,
    };

    const projectDir = path.join(process.cwd(), projectName);
    const sources = ['common', `patterns/${pattern}`];
    if (argv.files) sources.push('features/file-tools');
    if (kbProvider === 'vertex-ai-search') {
      const provider = listProviders().find((p) => p.id === 'vertex-ai-search');
      if (provider) sources.push(...provider.templateSources());
    }

    const scaffolder = new Scaffolder();
    const written = await scaffolder.run({
      destination: projectDir, context: ctx, sources, overwrite: argv.force,
    });
    const parsed = AgentqConfigSchema.parse({
      schema_version: 1,
      project: ctx.project, agent: ctx.agent, deployment: ctx.deployment,
      runtime: ctx.runtime, knowledge_base: ctx.knowledge_base,
      observability: ctx.observability, hooks: { pre_deploy: null, post_deploy: null },
    });
    await writeConfig(path.join(projectDir, 'agentq.config.yaml'), parsed);
    log.success(`Created ${written.length} files at ${projectDir}`);
  },
};
