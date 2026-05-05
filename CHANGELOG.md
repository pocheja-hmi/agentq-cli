# Changelog

All notable changes to `agentq-cli` will be documented in this file.

## [Unreleased]

### Added
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

### Fixed
- `pip` and `venv` provisioning runs silently behind a spinner; output is
  only shown if the install fails. Pass `--verbose` (or `AGENTQ_VERBOSE=1`)
  to stream realtime.
- Suppress harmless `Failed to register API methods` warning emitted by
  the Vertex SDK during `agentq list` / `deploy`. Verbose mode preserves it.

## [0.1.0] — Initial release

### Added
- `agentq init` — interactive walkthrough that scaffolds a new AgentQ project.
- `agentq new <pattern>` — non-interactive scaffolding for the four built-in
  orchestration patterns: `single`, `multi`, `sequential`, `hybrid`.
- `agentq deploy` — central deploy that reads `agentq.config.yaml` and
  creates/updates a Vertex AI Reasoning Engine. Supports optional
  `scripts/deploy_hooks.py` for project-specific pre/post hooks.
- `agentq list` — list every Reasoning Engine in the configured GCP project.
- `agentq destroy <resource>` — delete a deployment.
- `agentq logs <resource>` — tail Cloud Logging for a deployed agent.
- `agentq doctor` — verify gcloud auth, required APIs, Python toolchain,
  and `agentq.config.yaml` integrity.
- `agentq kb <subcommand>` — provision and manage the Vertex AI Search
  knowledge base for KB-enabled projects (create-bucket, upload, import,
  list, delete-doc, purge, delete-datastore).
- Pluggable `KBProvider` interface with `vertex-ai-search` as the v1 provider.
- Bundled Python runtime auto-installed into `.agentq/venv` per project.
