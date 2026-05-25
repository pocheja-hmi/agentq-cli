// Liskov-substitutable KB provider interface. Adding a Drive- or GCS-folder
// based KB later means: implement KBProvider, register it, expose it as a
// choice in `agentq init`. No other code changes.
import { AgentqConfig, KbProvider } from './config.js';
import { ProjectPaths } from './paths.js';

export interface KBContext {
  projectPaths: ProjectPaths;
  config: AgentqConfig;
  /** Active tier (dev/staging/prod) or null in legacy mode. Forwarded to the
   *  Python subcommands so they pick the right per-tier datastore. */
  tier: string | null;
}

export interface KBProvider {
  readonly id: KbProvider;
  readonly displayName: string;

  /** Files copied into the scaffold when this provider is chosen. */
  templateSources(): string[];

  /** Subcommand handlers, keyed by command name. */
  subcommands(ctx: KBContext): Record<string, (args: string[]) => Promise<void>>;

  /** Help text printed by `agentq kb --help`. */
  describe(): string;
}

const registry = new Map<KbProvider, KBProvider>();

export function registerProvider(p: KBProvider): void {
  registry.set(p.id, p);
}

export function getProvider(id: KbProvider): KBProvider | undefined {
  return registry.get(id);
}

export function listProviders(): KBProvider[] {
  return [...registry.values()];
}
