// `agentq init` — interactive walkthrough.
// Composes lib/scaffolder + lib/config; this command's only job is gathering
// answers and assembling the template context. No filesystem ops here.
import path from 'node:path';
import { input, select, confirm, number } from '@inquirer/prompts';
import type { CommandModule, Argv } from 'yargs';
import { Scaffolder } from '../lib/scaffolder.js';
import {
  type Pattern, type KbProvider, type ObservabilityLevel,
  AgentqConfigSchema, writeConfig,
} from '../lib/config.js';
import { listProviders } from '../lib/kb-provider.js';
import { buildRuntimePackages } from '../lib/runtime-packages.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  name?: string;
  force: boolean;
  yes: boolean;
}

function toSnakeCase(kebab: string): string {
  return kebab.replace(/-/g, '_');
}

function defaultStagingBucket(project: string): string {
  return `gs://${project}-agentq-staging`;
}

async function gatherAnswers(args: Args): Promise<Record<string, unknown>> {
  const projectName = args.name ?? await input({
    message: 'Project name (kebab-case)',
    validate: (v) =>
      /^[a-z][a-z0-9-]*$/.test(v) || 'Use lowercase letters, digits, and hyphens. Must start with a letter.',
  });

  const description = await input({ message: 'One-line description', default: '' });
  const displayName = await input({
    message: 'Display name (shown in Agent Designer / AgentQ)',
    default: projectName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  });
  const packageName = await input({
    message: 'Python package name',
    default: toSnakeCase(projectName),
    validate: (v) =>
      /^[a-z][a-z0-9_]*$/.test(v) || 'Use lowercase letters, digits, and underscores.',
  });

  const pattern: Pattern = await select({
    message: 'Orchestration pattern',
    choices: [
      { value: 'single',     name: 'single      — one LlmAgent (simplest)' },
      { value: 'multi',      name: 'multi       — orchestrator LlmAgent + sub-agents (LLM routing)' },
      { value: 'sequential', name: 'sequential  — fixed-order pipeline (deterministic)' },
      { value: 'hybrid',     name: 'hybrid      — orchestrator + a sequential sub-pipeline' },
    ],
  });

  let subAgents = 0;
  if (pattern === 'multi') {
    subAgents = (await number({ message: 'How many sub-agents?', default: 2, min: 1, max: 8 })) ?? 2;
  } else if (pattern === 'sequential') {
    subAgents = (await number({ message: 'How many pipeline stages?', default: 3, min: 2, max: 8 })) ?? 3;
  } else if (pattern === 'hybrid') {
    subAgents = (await number({ message: 'How many stages in the inner sequential pipeline?', default: 3, min: 2, max: 8 })) ?? 3;
  }

  const kbProvider: KbProvider = await select({
    message: 'Knowledge base',
    choices: [
      { value: 'none',             name: 'none              — no external knowledge' },
      { value: 'vertex-ai-search', name: 'vertex-ai-search  — managed search datastore' },
    ],
  });

  let datastoreId: string | null = null;
  let kbBucket: string | null = null;
  let kbLocation = 'global';
  if (kbProvider === 'vertex-ai-search') {
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

  const gcpProject = await input({ message: 'GCP project ID' });
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
    message: 'Use a user-managed runtime service account at deploy time?',
    default: false,
  });
  const serviceAccount = useServiceAccount
    ? await input({ message: 'Runtime SA email', default: `agentq-runtime@${gcpProject}.iam.gserviceaccount.com` })
    : null;

  const obsLevel: ObservabilityLevel = await select({
    message: 'Observability level',
    choices: [
      { value: 'basic',    name: 'basic     — tracing only' },
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

  return {
    projectName, packageName, description, displayName,
    pattern, subAgents,
    kbProvider, datastoreId, kbBucket, kbLocation,
    gcpProject, location, stagingBucket, model, serviceAccount,
    obsLevel, includeSampleTool, includeFileTools,
  };
}

async function buildContext(answers: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = answers as {
    projectName: string; packageName: string; description: string; displayName: string;
    pattern: Pattern; subAgents: number;
    kbProvider: KbProvider; datastoreId: string | null; kbBucket: string | null; kbLocation: string;
    gcpProject: string; location: string; stagingBucket: string; model: string;
    serviceAccount: string | null;
    obsLevel: ObservabilityLevel; includeSampleTool: boolean; includeFileTools: boolean;
  };

  const stages = Array.from({ length: a.subAgents }, (_, i) => ({
    index: i + 1,
    name: a.pattern === 'sequential' || a.pattern === 'hybrid' ? `stage_${i + 1}` : `agent_${i + 1}`,
    isFirst: i === 0,
    isLast:  i === a.subAgents - 1,
  }));

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
    flags: {
      pattern_single:     a.pattern === 'single',
      pattern_multi:      a.pattern === 'multi',
      pattern_sequential: a.pattern === 'sequential',
      pattern_hybrid:     a.pattern === 'hybrid',
      kb_enabled:         a.kbProvider !== 'none',
      kb_vertex:          a.kbProvider === 'vertex-ai-search',
      include_sample_tool: a.includeSampleTool,
      include_file_tools: a.includeFileTools,
      obs_basic:          a.obsLevel === 'basic',
      obs_standard:       a.obsLevel === 'standard',
      obs_advanced:       a.obsLevel === 'advanced',
    },
    stages,
  };
}

export const initCommand: CommandModule<{}, Args> = {
  command: 'init [name]',
  describe: 'Interactively scaffold a new AgentQ project.',
  builder: (y: Argv) =>
    y.positional('name', { type: 'string', describe: 'Project name (kebab-case).' })
     .option('force', { type: 'boolean', default: false, describe: 'Overwrite the destination directory if non-empty.' })
     .option('yes',   { type: 'boolean', default: false, alias: 'y', describe: '(Reserved.) Accept defaults non-interactively where possible.' }) as Argv<Args>,
  handler: async (argv) => {
    log.banner('AgentQ — new project');
    const answers = await gatherAnswers(argv);
    const ctx = await buildContext(answers);

    const projectDir = path.join(process.cwd(), (ctx.project as { name: string }).name);
    const sources = ['common', `patterns/${(ctx.agent as { pattern: string }).pattern}`];
    const flags = ctx.flags as { kb_vertex: boolean; include_file_tools: boolean };
    if (flags.include_file_tools) sources.push('features/file-tools');
    if (flags.kb_vertex) {
      const provider = listProviders().find((p) => p.id === 'vertex-ai-search');
      if (provider) sources.push(...provider.templateSources());
    }

    const scaffolder = new Scaffolder();
    const written = await scaffolder.run({
      destination: projectDir, context: ctx, sources, overwrite: argv.force,
    });

    // Write the canonical agentq.config.yaml from the validated schema.
    const cfgInput = {
      schema_version: 1,
      project: ctx.project, agent: ctx.agent, deployment: ctx.deployment,
      runtime: ctx.runtime, knowledge_base: ctx.knowledge_base,
      observability: ctx.observability, hooks: { pre_deploy: null, post_deploy: null },
    };
    const parsed = AgentqConfigSchema.parse(cfgInput);
    await writeConfig(path.join(projectDir, 'agentq.config.yaml'), parsed);

    log.success(`Created ${written.length} files at ${projectDir}`);
    log.raw('');
    log.raw('Next steps:');
    log.raw(`  cd ${(ctx.project as { name: string }).name}`);
    log.raw('  cp .env.example .env       # fill in any blank values');
    log.raw('  agentq doctor              # verify auth, APIs, config');
    if ((ctx.flags as { kb_enabled: boolean }).kb_enabled) {
      log.raw('  agentq kb create-bucket && agentq kb upload && agentq kb create-datastore && agentq kb import');
    }
    log.raw('  agentq deploy              # creates the Reasoning Engine');
    log.raw('');
  },
};
