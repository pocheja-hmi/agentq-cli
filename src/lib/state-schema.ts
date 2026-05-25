// Schema for the per-tier state.yaml file persisted in GCS.
//
// This is a DIFFERENT artifact from agentq.config.yaml:
//   config.yaml is INTENT — what the user wants deployed (lives in git).
//   state.yaml  is REALITY — what was actually deployed (lives in GCS).
//
// Separation matters because:
//   1. State mutates on every deploy; config mutates only when the developer
//      changes their mind. Mixing them puts the deploy bot in every PR.
//   2. State must outlive any individual project clone — multiple developers
//      can never agree on what's deployed if state is in the working tree.
//
// The schema is intentionally close in spirit to plan.schema.json's "after"
// fields — state is essentially the persisted version of the last successful
// plan's outputs. Drift detection compares (state.engine.config_hash) against
// (locally-computed config_hash).
import { z } from 'zod';

const KbDocumentSchema = z.object({
  filename:    z.string(),
  sha256:      z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex chars'),
  indexed_at:  z.string().datetime(),
  document_id: z.string(),                  // Gemini Enterprise Search Document.name leaf
  gcs_uri:     z.string().regex(/^gs:\/\//),
  size_bytes:  z.number().int().nonnegative().optional(),
});

const EngineStateSchema = z.object({
  resource_name:         z.string(),
  display_name:          z.string(),
  config_hash:           z.string(),         // 'sha256:<64-hex>'
  last_deployed_at:      z.string().datetime(),
  last_deployed_sha:     z.string(),
  last_deployed_by:      z.string(),         // user email or SA
  runtime_version:       z.string(),         // agentq-cli version that did this deploy
  agentq_schema_version: z.number().int().positive(),
});

// State files written by older CLIs may have `provider: vertex-ai-search`.
// Accept either form on read; the writer side always emits the canonical
// name. See config.ts::kbProviderField for the matching preprocess.
const stateKbProviderField = z.preprocess(
  (val) => (val === 'vertex-ai-search' ? 'gemini-enterprise-search' : val),
  z.enum(['none', 'gemini-enterprise-search']),
);

const KbStateSchema = z.object({
  provider:     stateKbProviderField,
  datastore_id: z.string().nullable(),
  bucket:       z.string().nullable(),
  location:     z.string(),
  documents:    z.array(KbDocumentSchema).default([]),
  // Top-level "have docs changed?" check. Cheap pre-filter before per-file
  // comparison — same computation on both diff and apply sides.
  docset_hash:  z.string().default('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
});

const HistoryEntrySchema = z.object({
  at:                  z.string().datetime(),
  sha:                 z.string(),
  actor:               z.string(),
  op:                  z.enum(['apply', 'import', 'destroy']),
  plan_id:             z.string().nullable(),
  config_hash_before:  z.string().nullable(),
  config_hash_after:   z.string().nullable(),
  docset_hash_before:  z.string().nullable(),
  docset_hash_after:   z.string().nullable(),
});

export const StateSchema = z.object({
  schema_version: z.literal(1).default(1),
  project_name:   z.string(),
  tier:           z.enum(['dev', 'staging', 'prod']),
  gcp_project:    z.string(),
  location:       z.string(),
  engine:         EngineStateSchema.nullable(),    // null between destroy and next deploy
  kb:             KbStateSchema,
  history:        z.array(HistoryEntrySchema).default([]),  // ring buffer, cap 50
});

export type AgentqState     = z.infer<typeof StateSchema>;
export type KbDocument      = z.infer<typeof KbDocumentSchema>;
export type EngineState     = z.infer<typeof EngineStateSchema>;
export type KbState         = z.infer<typeof KbStateSchema>;
export type HistoryEntry    = z.infer<typeof HistoryEntrySchema>;

// Cap the history buffer — anything beyond this drops off the back. Audit
// trail is for debugging recent deploys; ancient deploys belong in Cloud
// Logging or git history, not in state.
export const HISTORY_CAP = 50;

export function pushHistory(state: AgentqState, entry: HistoryEntry): AgentqState {
  const history = [entry, ...state.history].slice(0, HISTORY_CAP);
  return { ...state, history };
}
