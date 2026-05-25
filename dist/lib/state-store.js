// GCS-backed persistence for state.yaml.
//
// One module owns every read/write/delete of the state object. Every other
// command depends on this abstraction; nobody reaches into @google-cloud/storage
// directly — that's how we keep concurrency semantics consistent and how we'll
// eventually swap the backend (Firestore, Spanner, …) without touching commands.
//
// CONCURRENCY MODEL — optimistic, single-writer per (project, tier):
//   1. read() returns { state, generation }. `generation` is the GCS object
//      generation number, treated as a fencing token.
//   2. write(target, state, ifGenerationMatch) uses GCS's
//      `If-Generation-Match` precondition. If the object's generation has
//      changed since the caller read it (i.e. someone else deployed between
//      our plan and our apply), GCS returns 412 — we surface that as a
//      ConcurrentDeployError with an actionable hint.
//   3. First write uses ifGenerationMatch=0 ("must not exist") to guard
//      against two concurrent first-deploys racing.
//
// This is the same model Terraform's GCS backend uses; well-understood, no
// extra services to deploy (no Cloud Spanner lock table, no Firestore
// transaction). The trade-off: heavy contention manifests as a CI re-run
// rather than waiting, which we judge acceptable at 20-project scale.
import { Storage } from '@google-cloud/storage';
import YAML from 'yaml';
import { AgentqError } from './errors.js';
import { StateSchema } from './state-schema.js';
export class ConcurrentDeployError extends AgentqError {
    constructor(stateUri, expectedGen, actualGen) {
        super(`Concurrent deploy detected on ${stateUri}.`, `The state file was modified between plan and apply. Re-run \`agentq state plan\` and \`agentq state apply\` from scratch. (expected generation ${expectedGen}, actual ${actualGen})`);
    }
}
export class StateNotFoundError extends AgentqError {
    constructor(stateUri) {
        super(`No state file at ${stateUri}.`, 'This tier has never been deployed. Run `agentq deploy --tier <t>` (first deploy) or `agentq state import --tier <t> --resource-name ...` to import an existing engine.');
    }
}
let _client = null;
function client() {
    if (_client)
        return _client;
    _client = new Storage();
    return _client;
}
function parseStateUri(target) {
    if (!target.state_bucket || !target.state_path) {
        throw new AgentqError('state-store requires a tier target (state_bucket + state_path).', 'Pass --tier on the command, or enable gitops in agentq.config.yaml.');
    }
    // state_bucket is "gs://<name>" or "gs://<name>/"; strip the prefix.
    const m = target.state_bucket.match(/^gs:\/\/([^/]+)\/?$/);
    if (!m) {
        throw new AgentqError(`Invalid state_bucket: ${target.state_bucket}. Expected gs://<bucket-name>.`);
    }
    return { bucket: m[1], objectName: target.state_path };
}
export function stateUri(target) {
    const { bucket, objectName } = parseStateUri(target);
    return `gs://${bucket}/${objectName}`;
}
/**
 * Read the state file from GCS.
 *
 * @returns null when the object does not exist (first deploy). Throws on
 *   any other error including malformed YAML or schema validation failure.
 */
export async function read(target) {
    const { bucket, objectName } = parseStateUri(target);
    const blob = client().bucket(bucket).file(objectName);
    let body;
    let metadata;
    try {
        const [exists] = await blob.exists();
        if (!exists)
            return null;
        [body] = await blob.download();
        metadata = (await blob.getMetadata())[0];
    }
    catch (err) {
        const code = err.code;
        if (code === 404)
            return null;
        throw new AgentqError(`Failed to read ${stateUri(target)}: ${err.message}`, 'Check that the state bucket exists and the deployer SA has roles/storage.objectViewer on it.');
    }
    let raw;
    try {
        raw = YAML.parse(body.toString('utf-8'));
    }
    catch (e) {
        throw new AgentqError(`Could not parse state YAML at ${stateUri(target)}: ${e.message}`);
    }
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new AgentqError(`State file at ${stateUri(target)} failed schema validation:\n${issues}`);
    }
    const generation = Number(metadata.generation ?? 0);
    return { state: parsed.data, generation };
}
/**
 * Write the state file with optimistic-concurrency protection.
 *
 * @param ifGenerationMatch
 *   - 0    → object MUST NOT exist (first deploy)
 *   - n>0  → object's generation MUST equal n (you read at n, no one wrote since)
 *   - null → unconditional write (use sparingly; only `state import` does this)
 */
export async function write(target, state, ifGenerationMatch) {
    const validated = StateSchema.parse(state);
    const { bucket, objectName } = parseStateUri(target);
    const blob = client().bucket(bucket).file(objectName);
    const body = YAML.stringify(validated, { indent: 2, lineWidth: 120 });
    try {
        const options = {
            contentType: 'application/yaml',
            metadata: { cacheControl: 'no-cache, no-store, max-age=0' },
        };
        if (ifGenerationMatch != null) {
            options.preconditionOpts =
                { ifGenerationMatch };
        }
        await blob.save(body, options);
        const meta = (await blob.getMetadata())[0];
        return { generation: Number(meta.generation ?? 0) };
    }
    catch (err) {
        const code = err.code;
        if (code === 412) {
            throw new ConcurrentDeployError(stateUri(target), ifGenerationMatch, null);
        }
        throw new AgentqError(`Failed to write ${stateUri(target)}: ${err.message}`, 'Check that the deployer SA has roles/storage.objectAdmin on the state bucket.');
    }
}
/** Delete the state object. Used by `agentq destroy` and `agentq state rm`. */
export async function remove(target) {
    const { bucket, objectName } = parseStateUri(target);
    const blob = client().bucket(bucket).file(objectName);
    try {
        const [exists] = await blob.exists();
        if (!exists)
            return false;
        await blob.delete();
        return true;
    }
    catch (err) {
        throw new AgentqError(`Failed to delete ${stateUri(target)}: ${err.message}`);
    }
}
// FOR TESTING ONLY — let tests inject a fake Storage client.
export function _setStorageClient(c) {
    _client = c;
}
//# sourceMappingURL=state-store.js.map