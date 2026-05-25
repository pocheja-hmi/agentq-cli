// `agentq kb <subcommand>` — knowledge-base management.
//
// Tier-aware: --tier selects which tiers.<t>.kb block is operated on.
// Without --tier, defaults to gitops.default_tier (when GitOps enabled)
// or the legacy knowledge_base block.
//
// Mutation gating: tiers with kb.allow_freeform_mutation=false (typically
// staging + prod) refuse mutating subcommands unless --allow-prod-kb-mutation
// is passed. The CI workflow passes this flag because the workflow itself
// IS the gate (only triggered by approved merges). Local users get an error
// pointing them at the GitOps flow.
import path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import { findProjectRoot, projectPaths } from '../lib/paths.js';
import { loadConfig, TIERS } from '../lib/config.js';
import { resolveTarget } from '../lib/tier-resolver.js';
import { getProvider, listProviders } from '../lib/kb-provider.js';
import { log } from '../lib/logger.js';
import { AgentqError } from '../lib/errors.js';

interface Args {
  subcommand?: string;
  args?: string[];
  'project-dir'?: string;
  tier?: string;
  'allow-prod-kb-mutation': boolean;
}

// Subcommands that MUTATE the datastore. Gated by allow_freeform_mutation.
const MUTATING_SUBS = new Set([
  'create-bucket',
  'upload',
  'create-datastore',
  'import',
  'delete-doc',
  'purge',
  'delete-datastore',
]);

export const kbCommand: CommandModule<{}, Args> = {
  command: 'kb [subcommand] [args..]',
  describe: 'Manage the knowledge base for this project (per-tier in GitOps mode).',
  builder: (y: Argv) =>
    y.positional('subcommand', { type: 'string', describe: 'KB subcommand (omit to see help).' })
     .positional('args', { type: 'string', array: true, describe: 'Arguments forwarded to the subcommand.' })
     .option('project-dir', { type: 'string' })
     .option('tier', { type: 'string', choices: TIERS as readonly string[], describe: 'Operate on a specific tier (defaults to gitops.default_tier or legacy).' })
     .option('allow-prod-kb-mutation', { type: 'boolean', default: false, describe: 'Override the tier policy that disallows direct KB mutation on staging/prod tiers.' }) as Argv<Args>,
  handler: async (argv) => {
    const root = argv['project-dir']
      ? path.resolve(argv['project-dir'])
      : (await findProjectRoot()) ?? null;
    if (!root) {
      throw new AgentqError('Run from inside an AgentQ project, or pass --project-dir.');
    }
    const cfg = await loadConfig(path.join(root, 'agentq.config.yaml'));
    const pp = projectPaths(root, cfg.project.package);
    const target = resolveTarget(cfg, argv.tier);

    // Determine which provider to dispatch to. In tier mode, gemini-enterprise-search
    // is the only v1 provider. In legacy mode, read from cfg.knowledge_base.
    const providerId = target.tier
      ? (target.kb.datastore_id ? 'gemini-enterprise-search' : 'none')
      : cfg.knowledge_base.provider;
    if (providerId === 'none') {
      throw new AgentqError(
        target.tier
          ? `Tier ${target.tier} has no kb.datastore_id configured.`
          : 'This project was scaffolded without a knowledge base.',
        target.tier
          ? 'Add tiers.' + target.tier + '.kb.datastore_id to agentq.config.yaml.'
          : 'Set knowledge_base.provider in agentq.config.yaml, then re-scaffold the KB templates.',
      );
    }
    const provider = getProvider(providerId);
    if (!provider) {
      const known = listProviders().map((p) => p.id).join(', ');
      throw new AgentqError(
        `Unknown KB provider: ${providerId}`,
        `Known providers: ${known}`,
      );
    }

    if (!argv.subcommand) {
      log.raw(provider.describe());
      if (target.tier) {
        log.raw('');
        log.raw(`Active tier: ${target.tier} (datastore: ${target.kb.datastore_id ?? '(unset)'})`);
        log.raw(`Mutation policy: allow_freeform_mutation=${target.kb.allow_freeform_mutation}`);
      }
      return;
    }

    // Gate: mutating subcommands on non-freeform tiers require explicit opt-in.
    if (MUTATING_SUBS.has(argv.subcommand)
        && !target.kb.allow_freeform_mutation
        && !argv['allow-prod-kb-mutation']) {
      throw new AgentqError(
        `Tier '${target.tier ?? '(legacy)'}' disallows direct KB mutation.`,
        'Pass --allow-prod-kb-mutation to override (only the GitOps workflow should do this).' +
        ' For dev work, use the dev tier which has allow_freeform_mutation: true.',
      );
    }

    // Build the args list: the provider's subcommands(...) get the resolved
    // tier so they can pass --tier through to the Python kb runtime.
    const subs = provider.subcommands({
      projectPaths: pp,
      config: cfg,
      tier: target.tier,
    });
    const handler = subs[argv.subcommand];
    if (!handler) {
      throw new AgentqError(
        `Unknown subcommand: ${argv.subcommand}`,
        `Available: ${Object.keys(subs).join(', ')}`,
      );
    }
    await handler(argv.args ?? []);
  },
};
