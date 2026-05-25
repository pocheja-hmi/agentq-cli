# Design — `agentq-cli` + `agentq-actions`

This document explains **why** the system is shaped the way it is. It is a
maintained reference, not a build plan. Read this when:

- You need to understand the trade-off behind a specific decision.
- You're considering a structural change and want to know what invariants to preserve.
- You're onboarding a teammate and the surface-level docs leave them with "but why?"

The "how to use it" lives in [`GETTING_STARTED.md`](GETTING_STARTED.md) and
the per-repo READMEs. The "what changed when" lives in [`CHANGELOG.md`](../CHANGELOG.md).

---

## 1. Goals and constraints (in scope at design time)

| Need | Why it shaped the design |
|---|---|
| Production-grade deploys for ~20+ projects within a quarter | Per-project workflow drift becomes painful fast. A versioned shared workflow + central deploy logic was cheaper to build once than to fix 20 times. |
| GitOps — deploy via branch events, no laptop deploys for prod | Single deployer (the bot) means the persisted state-of-truth can't live in tracked YAML. It has to live somewhere the bot owns. |
| Two GCP projects (dev + prod), not three | Three was the textbook answer; two is what teams actually have. Staging became a logical tier *inside* the prod GCP, with its own SAs, datastore, and labels. |
| Per-tier KB datastores | Staging's whole point is to be a safety net before prod. If staging and prod share a datastore, the safety net has a hole. |
| OIDC + WIF, no long-lived secrets in GitHub | Hard requirement for any production-grade GitOps in 2026. |
| Existing projects (RFI pipeline, taxonomy validator) shouldn't need re-deploys | Required a migration path that imports an existing engine into the new state model without re-creating it. |
| Drift detection — CI must fail loudly when reality diverges from intent | Out-of-band changes (Cloud console edits, manual `gcloud` calls) are inevitable. Silent drift was the worst failure mode we wanted to prevent. |

---

## 2. The two-repo split

`agentq-cli` is the CLI; `agentq-actions` is a separate repo that hosts the
reusable GitHub workflow.

**Why split?**

1. **Versioning independence.** The CLI ships frequently as developers iterate
   on commands. The reusable workflow needs slow, careful releases because
   20+ projects float on it. Separate repos = separate release cadences.
2. **Floating major branches.** `agentq-actions` uses `@v1` floating tags so
   teams pick up patches automatically by re-running CI; major bumps are
   explicit. Same trick doesn't work for the CLI (which is pinned in
   workflows via `cli_version: vX.Y.Z`).
3. **One scaffolded workflow line.** Every team's `.github/workflows/agentq-deploy.yml`
   is ~25 lines of plumbing that calls `uses: HorizonMedia/agentq-actions/.github/workflows/deploy.yml@v1`.
   The actual logic — auth, plan, apply, drift check, prod gate — is one place.

**Alternative we rejected: a monorepo.** Tempting because the CLI's
`plan.schema.json` is the contract both sides validate against. But: GitHub
Actions versioning is per-repo, the CLI's release cycle is faster, and
keeping them separate forced us to lock the cross-repo contract on paper
first — which turned out to be valuable for the architecture.

**How we handle the cross-repo contract:** `plan.schema.json` lives canonically
in `agentq-cli/python/agentq_runtime/schemas/`. `agentq-actions` vendors a
byte-identical copy under `tests/golden/`. The `self-test.yml` workflow in
`agentq-actions` diffs them on every PR; drift fails the build.

---

## 3. Why state lives in GCS, not in tracked YAML

In the pre-GitOps world, `deployment.resource_name` in `agentq.config.yaml`
recorded "this engine is deployed at projects/.../reasoningEngines/123".
That works for one developer's laptop. It's hostile to GitOps because:

- Every deploy mutates the YAML.
- Every PR's diff includes a line nobody reviewed.
- Two CI runs deploying concurrently race on the same line.

**The fix:** state moves to GCS at `gs://<state-bucket>/agentq/<project>/<tier>/state.yaml`.
The bot owns the bucket. The repo stays clean. Optimistic concurrency via
the GCS object generation token gives us atomic conflict detection.

**Why GCS and not Firestore / Spanner / a managed lock table?** GCS gives
us conditional writes (`If-Generation-Match`) for free. No extra service
to operate. Same model Terraform's GCS backend uses; well-understood at
20-project scale. The trade-off — heavy contention manifests as CI re-runs
rather than blocking waits — is acceptable; if we ever see contention we'd
move to a lock object rather than swap the whole backend.

**Why `project.name` is the state key, not the GitHub repo name.** Repos
can be renamed. Project names in `agentq.config.yaml` are the canonical
identity — the contract the team chose when they ran `agentq init`. Decoupling
state from repo identity means a `gh repo rename` doesn't orphan anything.

---

## 4. The `config_hash` drift token

State stores a sha256 of the deployment-affecting subset of the config:

- `project.{name, package, display_name}`
- `agent.*`
- `runtime.{model, python_packages (sorted), extra_packages (sorted), env_vars}`
- Selected fields of the active tier: `gcp_project`, `location`,
  `runtime_service_account`, `display_name_suffix`, `labels`, `kb.*`
- Legacy `deployment.*` and `knowledge_base.*` when not in tier mode

Deliberately **excluded** (changes to these don't mark drift):

| Excluded | Why |
|---|---|
| `schema_version` | YAML format detail, not a deploy concern. |
| `observability.*` | Callbacks attached at runtime; not part of the engine spec. |
| `hooks.*` | Project-local scripts. The path is metadata; the hook's behavior is on the implementer. |
| `runtime_version` (in state) | The CLI's own version. Bumping the CLI shouldn't mark every deployed engine as drifted. |
| Auto-injected env keys (`MODEL`, `KB_DATASTORE`, `GOOGLE_GENAI_USE_VERTEXAI`) | These are derived from other fields that ARE hashed. Including them would double-count. |

**Mirroring on the Python side.** `agentq_runtime/config_hash.py` is a byte-for-byte equivalent of
`src/lib/config-hash.ts`. They share a canonical-serialization algorithm
that sorts keys, strips nulls, and emits no whitespace. A parity test in
the integration suite hashes the same fixture through both implementations
and fails if they diverge — because asymmetric drift detection would be
the kind of bug nobody could debug.

Why mirror instead of having only Python compute it? Because `agentq state diff`
on the TS side wants to detect drift without launching a Python subprocess —
faster + lower-friction local UX. The mirror is the cost.

---

## 5. The service-account topology

Per GCP project, four service accounts:

| SA | Used by | Permissions |
|---|---|---|
| `agentq-deploy-<tier>` | CI on push events | `aiplatform.user`, `storage.objectAdmin`, `discoveryengine.editor`, `iam.serviceAccountUser` (to impersonate runtime SA), `iam.serviceAccountTokenCreator` |
| `agentq-runtime-<tier>` | The deployed engine itself | Minimal — `aiplatform.user`. Project-specific roles added per app. |
| `agentq-plan` | CI on `pull_request` events | Read-only: `aiplatform.viewer`, `storage.objectViewer`, `discoveryengine.viewer` |

**Why split deploy and runtime SAs?** Two reasons:
1. **Blast radius.** If a CI pipeline is compromised (someone leaks a deploy SA
   credential, a malicious workflow change), the runtime SA's permissions
   are still untouched. The deployed engine's identity is independent.
2. **Audit clarity.** Cloud Logging shows different actors for "deploy
   happened" vs "engine called Gemini Enterprise". They're different operations
   conceptually; they should be different identities.

**Why a separate plan SA for PRs?** Same blast-radius logic: a PR
runner that's somehow exploited (fork PR, malicious dependency) can ONLY
read — never mutate. The WIF binding restricts the plan SA to
`refs/pull/*` refs specifically. Deploy SAs are bound to exact branch refs
(`refs/heads/dev`, etc.).

---

## 6. Per-tier KB datastores

User-confirmed locked decision: three datastores per AgentQ project — one in
each GCP, one per tier (`<project>-dev-corpus`, `<project>-staging-corpus`,
`<project>-prod-corpus`).

**Why per-tier and not shared?**

- Staging's purpose is to validate changes before prod. If staging and prod
  share a corpus, KB doc changes can't be tested in staging without
  affecting prod simultaneously. Defeats the safety net.
- Per-tier datastores cost essentially nothing — Gemini Enterprise Search datastores
  are free; you pay for storage + indexing.

**Mutation gating.** `tiers.<t>.kb.allow_freeform_mutation` defaults to:
- `true` for dev → laptop users upload freely
- `false` for staging + prod → `agentq kb upload --tier prod` from a laptop
  refuses unless `--allow-prod-kb-mutation` is passed

The CI workflow passes that flag because the workflow itself is the gate
(only triggered by an approved PR merge). Local users hit the friction and
are pushed toward the GitOps flow.

**Per-file diffing.** State stores `kb.documents[]` as `{filename, sha256, document_id, gcs_uri}`. Plan compares
local files to state and categorizes added / changed / removed / unchanged.
Apply only acts on the delta: upload changed files, delete removed doc_ids,
trigger an INCREMENTAL import. Unchanged files are never re-indexed.

The `kb.docset_hash` is a cheap top-level "did anything change?" signal so
the diff can short-circuit when nothing's moved.

---

## 7. Plan / Apply separation

`agentq deploy --tier <t>` runs plan + apply back-to-back. `agentq state plan`
and `agentq state apply` are separate so CI can plan on a PR (and post the
diff as a comment) and then apply on merge.

**The plan is a versioned JSON artifact.** Schema lives at
`python/agentq_runtime/schemas/plan.schema.json` (v1). Every field is part
of the cross-repo contract — `agentq-actions`' PR-comment + step-summary
renderers consume it.

**The plan's `state_generation` field** is the GCS object generation token
the plan was computed against. Apply re-reads the state; if the current
generation is different, someone else deployed between plan and apply, and
apply aborts with a "concurrent deploy" error. Re-run plan + apply from
scratch — they're cheap.

**No plan TTL.** We don't time-bound plans. The generation token is sufficient:
if state hasn't changed, the plan is still valid no matter how old. Time-based
TTLs introduce clock skew bugs and don't actually protect against the failure
mode (someone updating state).

---

## 8. The promotion flow + prod gate

```
feature/foo ──PR──▶ dev ──PR──▶ staging ──PR──▶ main
                     │            │              │
                  deploy       deploy         deploy
                  to dev       to staging     to prod
```

Each PR runs plan-only; the merge triggers apply.

The prod tier gets an extra gate: **before applying to prod, CI verifies that
the staging tier was deployed from a commit that is an ancestor of the current
prod HEAD.** Mechanism:

1. Read `gs://.../<project>/staging/state.yaml`.
2. Extract `engine.last_deployed_sha`.
3. `git merge-base --is-ancestor <staging_sha> <current_sha>` → must succeed.
4. If staging is at a sibling commit or behind, fail with a clear message.

This is the load-bearing invariant: **prod has been validated by staging at
some ancestor commit.** Without it, the staging tier is just a placebo.

For hotfixes that legitimately skip staging, the operator cherry-picks the
fix to staging first, waits for green, then merges to main. It costs 5–10
extra minutes but maintains the invariant. The alternative — a "bypass the
gate" flag — would be the most common cause of prod incidents.

---

## 9. The `tier-resolver` is the single source of truth for routing

Coexistence rules for legacy and GitOps modes are encoded in exactly one
place: `src/lib/tier-resolver.ts`'s `resolveTarget()` function (mirrored on
the Python side at `AgentqConfig.resolve_target()`). Order of precedence:

1. `--tier <t>` passed explicitly → use `tiers[t]`.
2. `gitops.enabled === true` and no `--tier` → use `tiers[gitops.default_tier]`.
3. Otherwise → use legacy `cfg.deployment` and `cfg.knowledge_base`.

Every command (`deploy`, `destroy`, `kb`, `state`, `setup-cicd`) calls
`resolveTarget()` and consumes the resulting `ResolvedTarget` struct. No
command does its own tier math. If we ever need a 4th tier or rename
"staging" to "qa", we change it in `tier-resolver.ts` and TIERS.

**Backwards-compatible deployment block synthesis.** v2 GitOps YAMLs MAY omit
the legacy `deployment:` block entirely. When that happens, `loadConfig()`
synthesizes one from the default tier so all the legacy consumers of
`cfg.deployment.*` keep working unchanged. This was the only way to make the
refactor incremental — making `deployment` optional in the TypeScript type
would have forced null-checks across 5 command files in one go.

---

## 10. Why `cfg.deployment` is still required (TS type-wise)

Looking at `src/lib/config.ts`, you'll see `deployment: DeploymentSchema`
(required), not optional, even in schema v2. This is deliberate:

- A v2 YAML may omit `deployment:` — that's user-facing flexibility.
- After parsing, every consumer of `cfg.deployment.*` gets a populated object.
  No null checks scattered through 5 files.
- The synthesis happens in `loadConfig()`'s pre-process step, before zod
  parsing, and reads from `tiers[gitops.default_tier]`.

A future refactor could make it optional once every consumer has been
migrated to use `tier-resolver`'s `ResolvedTarget` exclusively. For now,
the synthesis shim is the right trade-off — adds 10 lines, saves a
disruptive type churn.

---

## 11. SOLID/DRY hot-spots that matter

The architecture has four single-responsibility nodes that ALL routing
flows through. Don't duplicate them:

| Concern | Owner |
|---|---|
| "What target does this command operate on?" | `src/lib/tier-resolver.ts` (TS), `config.py::resolve_target` (Py) |
| "How do we read/write the GCS state file?" | `src/lib/state-store.ts` |
| "What goes into the drift hash?" | `src/lib/config-hash.ts` (TS), `config_hash.py` (Py, MIRROR) |
| "How is the plan structured?" | `python/agentq_runtime/schemas/plan.schema.json` |

If you find yourself implementing any of these a second time somewhere
else, stop. Add the new requirement to the one place and call it from there.

Similarly, every command file (`src/commands/*.ts`) is a thin orchestrator
that composes lib functions. Resist the urge to put logic in commands.

---

## 12. What's intentionally simple and may grow up later

Things we deliberately picked the simpler option for, with notes on when to
revisit:

| Today | When to revisit |
|---|---|
| Optimistic concurrency via GCS generation token | If teams report frequent re-runs from concurrent deploys, add a lock object (TTL'd) at `gs://.../<project>/<tier>/state.lock`. |
| `force-apply` PR label as drift override | If "label spam" becomes a problem, switch to GitHub Environments with required reviewers. The workflow already supports adding `environment: prod` for prod-tier jobs. |
| One staging GCP-project (shared with prod) | If staging-related outages start affecting prod, split into a separate staging GCP. The CLI's tier model accommodates this without code changes — only `tiers.staging.gcp_project` needs to change. |
| Schema bumps require coordinated CLI + actions releases | If this becomes routine, automate the mirror via a GitHub bot. |
| Self-deploy nightly test in agentq-actions = real Reasoning Engine create + destroy | ~$5-15/day in sandbox. Acceptable now; if growing, move to a more synthetic test. |
| `plan.json` artifact retention = 30 days in GitHub | If compliance needs longer audit trails, ship to a long-lived GCS bucket via a post-apply step. |

---

## 13. Glossary of jargon

| Term | Meaning |
|---|---|
| **Tier** | One of `dev`, `staging`, `prod`. Encoded in `tiers.<name>` in `agentq.config.yaml`. |
| **Target** | The flattened result of resolving a config + tier flag. What every command actually operates against. |
| **State file** | `gs://<state-bucket>/agentq/<project_name>/<tier>/state.yaml`. The bot's persistent memory of what's deployed where. |
| **Generation token** | The GCS object generation. Our optimistic-concurrency fence. |
| **Drift** | Deployed reality ≠ recorded state. Plan detects it; apply fails on it. |
| **Plan** | A JSON artifact describing what apply would do. Versioned by `schema_version`. |
| **Deploy SA** | The CI's identity at deploy time. Has write IAM. |
| **Runtime SA** | The deployed engine's identity. Has minimal IAM. |
| **Plan SA** | Read-only SA used by CI on `pull_request` events. |
| **WIF** | Workload Identity Federation — Google's OIDC bridge. Lets GitHub Actions impersonate GCP SAs without a key. |
| **Force-apply** | A PR label that overrides drift detection. Last-resort, audited via GitHub. |
| **The plan contract** | `plan.schema.json`. Cross-repo. Versioned. Mirror is byte-identical between repos. |
