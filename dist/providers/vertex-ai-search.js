// Concrete KBProvider for Gemini Enterprise Search. Subcommands shell out to the
// shared Python runtime where the discoveryengine SDK lives.
import { registerProvider } from '../lib/kb-provider.js';
import { runPython } from '../lib/python.js';
import { AgentqError } from '../lib/errors.js';
const SUBCMDS = [
    'create-bucket', 'create-datastore', 'upload', 'import',
    'list', 'delete-doc', 'purge', 'delete-datastore',
];
class VertexAiSearchProvider {
    id = 'vertex-ai-search';
    displayName = 'Gemini Enterprise Search';
    templateSources() {
        return ['kb/vertex-ai-search'];
    }
    subcommands(ctx) {
        const handlers = {};
        for (const cmd of SUBCMDS) {
            handlers[cmd] = async (args) => {
                if (cmd === 'delete-doc' && args.length === 0) {
                    throw new AgentqError('delete-doc requires a document ID argument.');
                }
                // Forward --tier through to the Python kb runtime so it picks the
                // right per-tier datastore. argparse on the Python side is forgiving
                // about the order: positional args first, --tier last.
                const pyArgs = [cmd, ctx.projectPaths.configFile, ...args];
                if (ctx.tier)
                    pyArgs.push('--tier', ctx.tier);
                await runPython(ctx.projectPaths, 'agentq_runtime.kb', pyArgs);
            };
        }
        return handlers;
    }
    describe() {
        return [
            `${this.displayName} — manages a Gemini Enterprise Search datastore plus its source GCS bucket.`,
            '',
            'Subcommands:',
            '  create-bucket        Create the GCS bucket that holds source documents.',
            '  upload               Upload sample_docs/* (or your own files) to the bucket.',
            '  create-datastore     Create the Gemini Enterprise Search datastore.',
            '  import               (Re)index every file currently in the bucket.',
            '  list                 List indexed Document IDs.',
            '  delete-doc <id>      Delete one document from the index.',
            '  purge                Remove all documents (bucket files untouched).',
            '  delete-datastore     Tear down the entire datastore.',
        ].join('\n');
    }
}
registerProvider(new VertexAiSearchProvider());
//# sourceMappingURL=vertex-ai-search.js.map