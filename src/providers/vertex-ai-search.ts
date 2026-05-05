// Concrete KBProvider for Vertex AI Search. Subcommands shell out to the
// shared Python runtime where the discoveryengine SDK lives.
import { KBProvider, KBContext, registerProvider } from '../lib/kb-provider.js';
import { runPython } from '../lib/python.js';
import { AgentqError } from '../lib/errors.js';

const SUBCMDS = [
  'create-bucket', 'create-datastore', 'upload', 'import',
  'list', 'delete-doc', 'purge', 'delete-datastore',
];

class VertexAiSearchProvider implements KBProvider {
  readonly id = 'vertex-ai-search' as const;
  readonly displayName = 'Vertex AI Search';

  templateSources(): string[] {
    return ['kb/vertex-ai-search'];
  }

  subcommands(ctx: KBContext): Record<string, (args: string[]) => Promise<void>> {
    const handlers: Record<string, (args: string[]) => Promise<void>> = {};
    for (const cmd of SUBCMDS) {
      handlers[cmd] = async (args: string[]) => {
        if (cmd === 'delete-doc' && args.length === 0) {
          throw new AgentqError('delete-doc requires a document ID argument.');
        }
        await runPython(
          ctx.projectPaths,
          'agentq_runtime.kb',
          [cmd, ctx.projectPaths.configFile, ...args],
        );
      };
    }
    return handlers;
  }

  describe(): string {
    return [
      `${this.displayName} — manages a Vertex AI Search datastore plus its source GCS bucket.`,
      '',
      'Subcommands:',
      '  create-bucket        Create the GCS bucket that holds source documents.',
      '  upload               Upload sample_docs/* (or your own files) to the bucket.',
      '  create-datastore     Create the Vertex AI Search datastore.',
      '  import               (Re)index every file currently in the bucket.',
      '  list                 List indexed Document IDs.',
      '  delete-doc <id>      Delete one document from the index.',
      '  purge                Remove all documents (bucket files untouched).',
      '  delete-datastore     Tear down the entire datastore.',
    ].join('\n');
  }
}

registerProvider(new VertexAiSearchProvider());
