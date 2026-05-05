// Single source of truth for what `agentq.config.yaml` looks like.
// Every command that reads the config goes through loadConfig() — schema
// validation happens in exactly one place (DRY) and the rest of the codebase
// works against a strongly-typed object (single responsibility per consumer).
import fs from 'fs-extra';
import YAML from 'yaml';
import { z } from 'zod';
import { AgentqError } from './errors.js';

export const PATTERNS = ['single', 'multi', 'sequential', 'hybrid'] as const;
export type Pattern = (typeof PATTERNS)[number];

export const KB_PROVIDERS = ['none', 'vertex-ai-search'] as const;
export type KbProvider = (typeof KB_PROVIDERS)[number];

export const OBSERVABILITY_LEVELS = ['basic', 'standard', 'advanced'] as const;
export type ObservabilityLevel = (typeof OBSERVABILITY_LEVELS)[number];

const ProjectSchema = z.object({
  name:         z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case'),
  package:      z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case'),
  description:  z.string().default(''),
  display_name: z.string(),
});

const AgentSchema = z.object({
  pattern:       z.enum(PATTERNS),
  entry_module:  z.string(),    // e.g. my_project.agent
  entry_symbol:  z.string().default('root_agent'),
  sub_agents:    z.number().int().min(0).max(10).default(0),
});

const DeploymentSchema = z.object({
  gcp_project:    z.string(),
  location:       z.string().default('us-central1'),
  staging_bucket: z.string().regex(/^gs:\/\//, 'must start with gs://'),
  service_account: z.string().nullable().default(null),
  resource_name:  z.string().nullable().default(null),
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
  provider:     z.enum(KB_PROVIDERS).default('none'),
  datastore_id: z.string().nullable().default(null),
  bucket:       z.string().nullable().default(null),
  location:     z.string().default('global'),
});

const ObservabilitySchema = z.object({
  tracing: z.boolean().default(true),
  level:   z.enum(OBSERVABILITY_LEVELS).default('standard'),
});

const HooksSchema = z.object({
  pre_deploy:  z.string().nullable().default(null),
  post_deploy: z.string().nullable().default(null),
});

export const AgentqConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  project:       ProjectSchema,
  agent:         AgentSchema,
  deployment:    DeploymentSchema,
  runtime:       RuntimeSchema,
  knowledge_base: KnowledgeBaseSchema.default({}),
  observability: ObservabilitySchema.default({}),
  hooks:         HooksSchema.default({}),
});

export type AgentqConfig = z.infer<typeof AgentqConfigSchema>;

export async function loadConfig(file: string): Promise<AgentqConfig> {
  if (!(await fs.pathExists(file))) {
    throw new AgentqError(
      `agentq.config.yaml not found at ${file}`,
      'Run this command from inside an AgentQ project, or pass --project-dir.',
    );
  }
  const raw = await fs.readFile(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new AgentqError(`Could not parse YAML: ${(e as Error).message}`);
  }
  const result = AgentqConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new AgentqError(`Invalid agentq.config.yaml:\n${issues}`);
  }
  return result.data;
}

export async function writeConfig(file: string, cfg: AgentqConfig): Promise<void> {
  const yaml = YAML.stringify(cfg, { indent: 2, lineWidth: 100 });
  await fs.writeFile(file, yaml, 'utf-8');
}
