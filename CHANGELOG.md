# Changelog

All notable changes to `agentq-cli` will be documented in this file.

## [Unreleased]

## [0.2.2] — 2026-06-01

### Docs — Tarball install is now the documented consumer path
- `npm install -g github:HorizonMedia/agentq-cli#vX` is unreliable on
  npm 11.x + fnm + macOS: the global git-install code path silently
  drops `bin/`, `package.json`, README, and CHANGELOG from the
  installed package, leaving the `agentq` bin shim pointing at a
  non-existent file. Reproducible with both pinned tags and floating
  major branches.
- Documented consumer path is now the pre-packed tarball attached to
  every GitHub Release:
  `npm install -g https://github.com/HorizonMedia/agentq-cli/releases/download/vX.Y.Z/agentq-cli-X.Y.Z.tgz`.
- `scripts/release.sh` post-release instructions now spell out the
  `npm pack` + `gh release upload` step.
- CI (`agentq-actions/actions/setup/action.yml`) already used the
  clone + `npm install -g .` approach and was unaffected. No CI change
  needed.

### Added — `prepare` no-op
- `package.json` declares `"prepare": "node -e \"0\""`. Helps non-global
  git installs flip onto npm's pack/install pipeline; doesn't fix the
  global-install drop bug but is harmless.

## [0.2.1] — 2026-06-01

### Internal — `prepare` hook experiment (superseded by v0.2.2 docs change)
- Added a `prepare` script that rebuilt `dist/` on install. Withdrawn in
  v0.2.2 because devDependencies (including `typescript`) aren't surfaced
  during global git installs, so the build failed with
  `sh: tsc: command not found`. The committed `dist/` is the source of
  truth for consumers; nothing needs to be rebuilt at install time.

## [0.2.0] — 2026-06-01

### Changed — `config_hash` now folds the package source tree
- `compute_config_hash` (both TS and Python implementations) now
  incorporates a sha256 fingerprint of every shippable file under
  `<project_root>/src/<package>/` plus each `runtime.extra_packages`
  entry. Previously the hash only saw `agentq.config.yaml`, so
  source-only edits were invisible to plan/apply and consumers had to
  bump a manual `AGENT_DEPLOY_NONCE` env var to force a redeploy on
  every code change.
- File walk mirrors `deploy.py::_normalize_extra_packages` exactly so
  the hash covers what actually ships. `__pycache__/`, `*.pyc`, `*.pyo`,
  `.DS_Store`, and common cache/VCS dirs are excluded.
- **Migration**: zero-touch. Existing deployments will see one expected
  hash mismatch on the first `agentq plan` after upgrading (yaml-only
  hash → yaml+source hash) which triggers a single forced redeploy.
  Subsequent plans behave as before. Consumers can delete any
  `AGENT_DEPLOY_NONCE` workaround from their `agentq.config.yaml`.
- TS↔Python parity is covered by `src/lib/config-hash.test.ts`, which
  drives both sides off the same temp-directory fixture and asserts
  equal output before and after a source mutation.

### Changed — Knowledge-base provider id rename (with full backwards compat)
- The canonical KB provider id is now `gemini-enterprise-search` (was
  `vertex-ai-search`). All scaffolded YAMLs, state files, and CLI prompts
  emit the new name.
- **Migration**: zero-touch. Existing `agentq.config.yaml` files with
  `provider: vertex-ai-search` are still accepted — both the Node (zod) and
  Python loaders normalise the legacy name to canonical on read. Existing
  GCS `state.yaml` files do the same. No team needs to edit YAML.
- Internals: new `kbProviderField` in `src/lib/config.ts` (zod preprocessor)
  and matching `_normalize_kb_provider` + `KB_PROVIDER_ALIASES` in
  `python/agentq_runtime/config.py`. `state-schema.ts` has its own
  `stateKbProviderField` for state-file reads.
- Renames in this round (transparent to consumers):
    - `src/providers/vertex-ai-search.ts` → `src/providers/gemini-enterprise-search.ts`
    - Class `VertexAiSearchProvider` → `GeminiEnterpriseSearchProvider`
    - `templates/kb/vertex-ai-search/` → `templates/kb/gemini-enterprise-search/`
- Display strings in `agentq kb --help` now say "Gemini Enterprise Search".
- All documentation prose updated from "Vertex AI" to "Gemini Enterprise".
  SDK imports (`vertexai.*`), IAM roles (`roles/aiplatform.*`), and API
  endpoints (`aiplatform.googleapis.com`) are unchanged — those technical
  identifiers stay until Google renames them upstream.

### Added — GitOps (multi-tier deploys via GitHub Actions)
- `agentq.config.yaml` schema v2: optional `gitops:` and `tiers:` top-level
  blocks. Three tiers — `dev`, `staging`, `prod` — each with its own
  `gcp_project`, `staging_bucket`, `state_bucket`, deployer + runtime
  service accounts, labels, and per-tier KB datastore. Legacy v1 configs
  continue to work unchanged. GitOps mode is **opt-in via `agentq init`**;
  default is on.
- `loadConfig()` synthesizes a `deployment:` block from the default tier
  when omitted from a v2 YAML, so consumers of `cfg.deployment.*` keep
  working unchanged whether the YAML has the block or not.
- New library modules in `src/lib/`:
    - `tier-resolver.ts` — single source of truth for the legacy/gitops
      coexistence rules. Every command flows through here.
    - `state-store.ts` — GCS persistence for `state.yaml` with
      optimistic-concurrency via the object generation token.
    - `state-schema.ts` — zod schema for the per-tier state.yaml shape.
    - `state-sync.ts` — shared download/upload + git-SHA helpers used by
      both the `state` and `deploy` commands.
    - `config-hash.ts` — canonical-serialized sha256 of the deployment-
      affecting subset of config. Single drift token; mirrored on the
      Python side with a parity test fixture.
- `agentq state <subcommand>` — yargs group of six operations:
  `show`, `diff`, `plan`, `apply`, `import`, `rm`. Plans are written as
  `.agentq/plans/<tier>-<sha8>.json` files that conform to
  `python/agentq_runtime/schemas/plan.schema.json`. `apply` aborts if the
  state's GCS generation token has changed since the plan was computed
  (catches concurrent deploys cleanly).
- `agentq deploy --tier <dev|staging|prod>` — runs plan+apply in one shot
  against a tier's GCS state file. Legacy `agentq deploy` (no `--tier`)
  is unchanged.
- `agentq destroy --tier <t>` — destroys an engine AND clears the
  matching tier state file in GCS (instead of legacy `resource_name`).
  Auto-detects tier from the resource name when `--tier` is omitted.
- `agentq kb <subcommand> --tier <t> [--allow-prod-kb-mutation]` — every
  KB subcommand now accepts `--tier`. Mutating subcommands on tiers with
  `kb.allow_freeform_mutation: false` (staging + prod by default) require
  `--allow-prod-kb-mutation` — the override the CI workflow passes.
- `agentq setup-cicd` — one-shot idempotent bootstrap per GCP project.
  Enables APIs, creates the WIF pool + GitHub OIDC provider, deploy +
  runtime SA per tier, shared `agentq-plan` SA per GCP for PR runs, IAM
  bindings (incl. `iam.serviceAccountUser`/`TokenCreator` for SA
  impersonation), and the state bucket (versioning ON, 30-day noncurrent
  retention).
- Python runtime additions:
    - `agentq_runtime/state.py` — plan/diff/apply logic, KB file diffing
      via sha256 per file.
    - `agentq_runtime/config_hash.py` — Python mirror of TS `config-hash`.
      Locked to the same output via shared fixture.
    - `agentq_runtime/schemas/plan.schema.json` — the cross-repo
      integration contract. Versioned. Bytes-identical mirror lives in
      `agentq-actions/tests/golden/`.
    - `agentq_runtime/config.py` gained `Tier`, `TierKb`, `Gitops`
      dataclasses plus `resolve_target()` and `kb_for()`.
    - `agentq_runtime/deploy.py` and `kb.py` gained `_for_target()`
      variants of every command so `state.py::apply` can drive
      tier-targeted ops without re-implementing logic.
- `agentq init` and `agentq new` ask for / accept GitOps options
  (`--gitops`, `--dev-gcp-project`, `--prod-gcp-project`, branch names).
  When enabled, scaffolds `.github/workflows/agentq-deploy.yml` (the
  ~25-line caller that references `HorizonMedia/agentq-actions@v1`) and
  `docs/CICD_SETUP.md` (ops checklist with project-specific values).
- Companion repo `HorizonMedia/agentq-actions` (new, separate): hosts the
  reusable GitHub workflow and seven composite actions that all
  scaffolded projects call into. Versioned with floating major-branch
  pointers so 20+ projects upgrade by bumping one tag.
- New documentation:
    - `docs/GETTING_STARTED.md` — one-page end-to-end on-ramp.
    - `docs/DESIGN.md` — maintained "why" reference for the GitOps
      architecture, state model, drift detection, SA topology.

### Added — pre-GitOps
- File-handling tools (`list_uploaded_files`, `read_uploaded_file`) wired
  into single / multi / hybrid scaffolds when `--files` (default true) is
  selected. Backed by a pluggable `file_readers` registry that supports PDF,
  DOCX, XLSX/XLSM, CSV/TSV, JSON, Markdown, source code, YAML/TOML/INI,
  HTML/XML out of the box. Adding a format is one decorator call.
- `agentq new --files / --no-sample-tool` flags for non-interactive runs.
- `agentq init` now asks whether to include file-handling tools.
- `runtime.python_packages` in scaffolded `agentq.config.yaml` is now
  computed from the chosen capabilities, so the deployed container has the
  right deps (pypdf, python-docx, openpyxl) without hand-editing.
- `agentq deploy --recreate` — force creation of a NEW Reasoning Engine
  even if one is already persisted in `agentq.config.yaml`. The previous
  resource is left in place; `agentq destroy <old>` cleans it up
  separately. Mutually exclusive with `--update`.
- Deploy mode is now printed up-front with its reason
  (`mode: update  (resource_name found in agentq.config.yaml)` etc.) so
  it's obvious which path was chosen.
- `agentq destroy --purge` — additionally deletes the staging artifacts
  (`gs://<staging>/agent_engine/*`) left behind by the SDK. The default
  destroy only deletes the Reasoning Engine and clears its `resource_name`
  from `agentq.config.yaml`; `--purge` adds the GCS cleanup as an opt-in
  step because a staging bucket may be shared between AgentQ projects.
- `agentq destroy` now auto-clears the matching `deployment.resource_name`
  from `agentq.config.yaml` (so the next `agentq deploy` reverts to a
  fresh create instead of failing with "resource missing").
- `agentq destroy` cascades through child resources by default
  (`agent_engines.delete(force=True)`) — fixes "ReasoningEngine contains
  child resources: sessions" failures when destroying engines that have
  been chatted with.

### Fixed
- Vertex SDK `Logger.log_create_with_lro` AttributeError that broke every
  `agentq deploy`. Cause: `aiplatform.base.Logger` is a factory function
  that returns a stdlib `logging.Logger`, and Python's logger cache is
  populated before the SDK can install its `VertexLogger` subclass — so
  `_LOGGER.log_create_with_lro` never resolves. Patched in
  `agentq_runtime/_sdk_compat.py` (loaded automatically on every CLI
  invocation) with class-level patches on both `logging.Logger` and
  `VertexLogger` plus instance-level patches on the two live `_LOGGER`
  symbols inside `vertexai.agent_engines`. Future projects inherit the
  fix automatically; nothing to copy into scaffolded code.
- Container `ModuleNotFoundError: No module named '<package>'` on first
  deploy. Cause: extra_packages paths were absolute, so the SDK's tar
  preserved the full `src/<package>/` layout — the container needed
  `<package>/` at the tarball root to import it. Fixed in
  `agentq_runtime/deploy.py` with a new `_layout_root()` helper that
  chdirs into `<project>/src/` before `agent_engines.create()`, and
  `_normalize_extra_packages()` that strips legacy `./src/` prefixes and
  guarantees the project's main package is always included.
- `TypeError: after_model() got an unexpected keyword argument 'llm_response'`
  in the deployed container. Cause: scaffolded `observability.py` named
  the parameter `model_response`, but ADK invokes the callback with the
  keyword `llm_response=...`. Renamed in the template and documented with
  a doc-comment so future readers don't repeat the mistake.
- `agentq deploy` now translates "persisted resource no longer exists"
  failures into a clean one-line message with an actionable hint
  (`Run agentq deploy --recreate to deploy a fresh Reasoning Engine`)
  instead of dumping the full SDK NotFound traceback.
- `agentq_runtime.config.update_resource_name()` now accepts `None` so
  `agentq destroy` can clear the field without a type error.
- Defensive merge in `agentq_runtime/deploy.py::_ensure_required_packages`
  auto-adds `google-cloud-aiplatform[adk]`, `cloudpickle`, and `pydantic`
  to the container's pip-install list if they're missing from a project's
  `runtime.python_packages`. The Agent Engine SDK requires them in-container
  and warns at deploy time when they're absent.
- Bumped CLI-bundled Vertex SDK floor to
  `google-cloud-aiplatform[agent_engines,adk]>=1.95.0` to skip the
  intermediate `1.7x` releases where additional internal SDK bugs surfaced.
- `pip` and `venv` provisioning runs silently behind a spinner; output is
  only shown if the install fails. Pass `--verbose` (or `AGENTQ_VERBOSE=1`)
  to stream realtime.
- Suppress harmless `Failed to register API methods` warning emitted by
  the Vertex SDK during `agentq list` / `deploy`. Verbose mode preserves it.

### Changed
- `agentq.config.yaml::runtime.extra_packages` semantics: the field is now
  purely additive — the project's main package is always included
  automatically. Legacy entries like `./src/<package>` are silently
  normalized to just `<package>` so existing projects keep working without
  hand-editing.

## [0.1.0] — Initial release

### Added
- `agentq init` — interactive walkthrough that scaffolds a new AgentQ project.
- `agentq new <pattern>` — non-interactive scaffolding for the four built-in
  orchestration patterns: `single`, `multi`, `sequential`, `hybrid`.
- `agentq deploy` — central deploy that reads `agentq.config.yaml` and
  creates/updates a Reasoning Engine on Gemini Enterprise. Supports optional
  `scripts/deploy_hooks.py` for project-specific pre/post hooks.
- `agentq list` — list every Reasoning Engine in the configured GCP project.
- `agentq destroy <resource>` — delete a deployment.
- `agentq logs <resource>` — tail Cloud Logging for a deployed agent.
- `agentq doctor` — verify gcloud auth, required APIs, Python toolchain,
  and `agentq.config.yaml` integrity.
- `agentq kb <subcommand>` — provision and manage the Gemini Enterprise Search
  knowledge base for KB-enabled projects (create-bucket, upload, import,
  list, delete-doc, purge, delete-datastore).
- Pluggable `KBProvider` interface with `vertex-ai-search` as the v1 provider.
- Bundled Python runtime auto-installed into `.agentq/venv` per project.
