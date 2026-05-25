# `plan.schema.json` — cross-repo contract

This directory holds the JSON Schema for the **plan artifact** that flows from
`agentq state plan` (this repo) to:

- `agentq state apply` (same repo, but reads the artifact back like an external system would);
- the comment + summary renderers in [`agentq-actions`](https://github.com/HorizonMedia/agentq-actions).

## Why a JSON Schema and not a TS/Python type?

The two consumers live in different repos, different languages, and different
CI runs. A schema file gives us:

- One source of truth, copy-able into either codebase.
- Mechanical validation on both sides — `plan` writes are validated before
  upload; `apply` and `agentq-actions/scripts/render_comment.py` validate on
  read.
- A drift signal when the two repos disagree: agentq-actions vendors a copy
  under `tests/golden/plan.schema.json` and runs a diff against this file on
  every PR.

## Governance

- **Owner**: agentq-cli's `python/agentq_runtime/schemas/` directory is the
  canonical location. Any change to the schema starts here.
- **Mirror**: `agentq-actions/tests/golden/plan.schema.json` is a verbatim
  copy. Updated by hand (a 1-line PR) after the change lands here.
- **Versioning**: `schema_version` is an integer. Bump only on **breaking**
  changes (renamed field, removed field, type changed). Adding optional
  fields with sensible defaults is non-breaking.
- **Per-version migration**: when bumping `schema_version`, add a `MIGRATION.md`
  entry in both repos with: what changed, why, how to read the old shape if
  needed (the CLI's `state apply` rejects plans with mismatched
  `schema_version`).

## Lifetime + persistence

A plan file is **ephemeral**: written by `agentq state plan` to
`.agentq/plans/<tier>-<sha>.json`, consumed by `agentq state apply`, then
either uploaded as a GitHub Actions artifact (30-day retention) or discarded.
The plan is NOT a state file. The persistent state of a deployed engine lives
in the GCS state file (`state.yaml`).

## What the schema contains

| Top-level field | Purpose |
|---|---|
| `schema_version` | The contract version. |
| `metadata` | When/who/what — for PR comments and audit. |
| `target` | Which tier, which GCP project, which agent. |
| `engine_plan` | Mode (no_op/create/update/recreate), config diff, hashes. |
| `kb_plan` | Per-file KB diff (added/changed/removed/unchanged) + action. |
| `runtime_plan` | pip + env diff. |
| `drift` | Out-of-band changes detected vs the persisted state. |
| `state_generation` | GCS object generation token for optimistic concurrency. |
| `risks` | Advisory items the PR comment surfaces. |

See `plan.example.json` in this directory for a complete, well-formed example.

## Tooling

Validate a plan against this schema locally:

```bash
pip install jsonschema
python -c "
import json, sys
import jsonschema
schema = json.load(open('python/agentq_runtime/schemas/plan.schema.json'))
plan   = json.load(open('python/agentq_runtime/schemas/plan.example.json'))
jsonschema.validate(plan, schema)
print('OK')
"
```

## Adding a field (non-breaking)

1. Edit `plan.schema.json` — add the field with a default or mark it optional.
2. Update `plan.example.json` to include the new field.
3. Update `state.py::write_plan()` to populate it.
4. Update `agentq-actions/scripts/render_comment.py` (or summary script) to
   surface it if user-visible.
5. Open the 1-line mirror PR in `agentq-actions` updating
   `tests/golden/plan.schema.json`.

No `schema_version` bump needed.

## Bumping `schema_version` (breaking)

1. Bump `schema_version` constant in `plan.schema.json` from N → N+1.
2. Update `plan.example.json`.
3. Update both repos' CHANGELOG with the breaking entry.
4. Add a `MIGRATION.md` section explaining the change.
5. Cut a major-version release of `agentq-actions` (e.g. `@v1` → `@v2`).
6. Scaffolded workflows pin to the older `@v1` until teams upgrade.
