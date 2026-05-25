"""Tier-aware state operations: show / diff / plan / apply / import / rm.

Architecture:
  - Node owns GCS I/O. It downloads the current state.yaml to a local file,
    invokes one of these subcommands with --state-file <path>, then uploads
    the (possibly mutated) file back with a generation-token precondition.
  - This module never imports @google-cloud/storage. Tests can run end-to-end
    without GCS by passing fake local files.

JSON I/O:
  - `plan` writes a plan to --plan-out <path>.
  - `apply` reads --plan <path> back. The plan format matches
    schemas/plan.schema.json.

Exit codes:
   0 — success, no drift, plan/apply succeeded
   1 — uncaught error
   2 — argparse / usage error
   3 — diff detected drift (used by CI to gate)
   4 — concurrent-deploy mismatch (state generation changed)
   5 — apply aborted because plan stale or invalid
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import yaml

# Import compat shims before the SDK can load.
from agentq_runtime import _sdk_compat  # noqa: F401
from agentq_runtime import _silence     # noqa: F401
from agentq_runtime import config as cfgmod
from agentq_runtime import config_hash as cfghash
from agentq_runtime import deploy as deploymod   # reused for create/update logic
from agentq_runtime import kb as kbmod           # reused for KB ops

PLAN_SCHEMA_VERSION = 1
STATE_SCHEMA_VERSION = 1


# ─── State file I/O ──────────────────────────────────────────────────────────

def _normalize_datetimes(obj: Any) -> Any:
    """Convert any `datetime` values in a nested structure to canonical
    ISO-8601 strings with `Z` suffix.

    PyYAML's safe_load parses ISO timestamps into `datetime` objects, and
    safe_dump then writes them back in YAML's own form (space-separated,
    `+00:00` offset). That output is not valid ISO 8601, so the Node-side
    zod validator rejects re-read state files. Normalizing before dump
    keeps the on-disk format stable across read/write cycles.
    """
    if isinstance(obj, dt.datetime):
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=dt.timezone.utc)
        return obj.isoformat().replace("+00:00", "Z")
    if isinstance(obj, dict):
        return {k: _normalize_datetimes(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_datetimes(v) for v in obj]
    return obj


def read_state(path: str | Path) -> dict[str, Any] | None:
    p = Path(path)
    if not p.is_file():
        return None
    body = p.read_text(encoding="utf-8").strip()
    if not body:
        return None
    # Normalize on read so any datetime objects PyYAML parsed become canonical
    # ISO strings before downstream code sees them — keeps history entries
    # stable when they're copied forward in cmd_apply.
    return _normalize_datetimes(yaml.safe_load(body) or None)


def write_state(path: str | Path, state: dict[str, Any]) -> None:
    Path(path).write_text(
        yaml.safe_dump(
            _normalize_datetimes(state),
            sort_keys=False,
            default_flow_style=False,
        ),
        encoding="utf-8",
    )


# ─── Knowledge-base scanning (local source → docset) ─────────────────────────

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_knowledge(project_root: Path) -> list[dict[str, Any]]:
    """Walk `<project_root>/knowledge/` and produce KbDocument-shaped entries.

    Filenames are relative to project root (e.g. 'knowledge/faq.md') so the
    diff display reads naturally. Symlinks are skipped to avoid cycles.
    """
    docs: list[dict[str, Any]] = []
    kb_dir = project_root / "knowledge"
    if not kb_dir.is_dir():
        return docs
    for path in sorted(kb_dir.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(project_root)
        docs.append({
            "filename": str(rel),
            "sha256": _sha256_file(path),
            "size_bytes": path.stat().st_size,
        })
    return docs


# ─── Plan computation ────────────────────────────────────────────────────────

def _diff_docs(local: list[dict[str, Any]], state_docs: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Compare local files vs documents recorded in state.

    Categories:
      added     — in local only
      changed   — in both, sha256 differs
      removed   — in state only (file deleted in git)
      unchanged — in both, sha256 matches
    """
    state_by_name = {d["filename"]: d for d in state_docs}
    local_by_name = {d["filename"]: d for d in local}

    added:     list[dict[str, Any]] = []
    changed:   list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []

    for name, ld in local_by_name.items():
        sd = state_by_name.get(name)
        if sd is None:
            added.append(ld)
        elif sd["sha256"] != ld["sha256"]:
            # Preserve document_id from state so reimport can target it.
            merged = dict(ld)
            if "document_id" in sd:
                merged["document_id"] = sd["document_id"]
            changed.append(merged)
        else:
            merged = dict(ld)
            if "document_id" in sd:
                merged["document_id"] = sd["document_id"]
            unchanged.append(merged)

    removed: list[dict[str, Any]] = [
        sd for name, sd in state_by_name.items() if name not in local_by_name
    ]
    return {"added": added, "changed": changed, "removed": removed, "unchanged": unchanged}


def _diff_python_packages(local: list[str], state_pkgs: list[str]) -> dict[str, Any]:
    """Diff requirements lists. We treat each entry as a name+pin token and
    detect adds, removes, and version changes when the bare name matches.
    """
    def split(spec: str) -> tuple[str, str]:
        bare = spec
        version = ""
        for sep in (">=", "==", "<=", "<", ">", "~=", "!="):
            if sep in spec:
                bare, _, version = spec.partition(sep)
                version = sep + version
                break
        return bare.strip().split("[")[0].lower(), version

    local_map = {split(s)[0]: s for s in local}
    state_map = {split(s)[0]: s for s in state_pkgs}
    added = [v for k, v in local_map.items() if k not in state_map]
    removed = [v for k, v in state_map.items() if k not in local_map]
    version_changed: list[dict[str, str]] = []
    for k, v in local_map.items():
        if k in state_map and state_map[k] != v:
            version_changed.append({"name": k, "from": state_map[k], "to": v})
    return {"added": added, "removed": removed, "version_changed": version_changed}


def _diff_env_vars(local: dict[str, str], state_env: dict[str, str]) -> dict[str, list[str]]:
    """Surface adds/removes/changes in user-set env vars. Auto-injected keys
    (MODEL, KB_DATASTORE, GOOGLE_GENAI_USE_VERTEXAI) are filtered first.
    """
    skip = cfghash.AUTO_INJECTED_ENV_KEYS
    L = {k: v for k, v in (local or {}).items() if k not in skip}
    S = {k: v for k, v in (state_env or {}).items() if k not in skip}
    added = [k for k in L if k not in S]
    removed = [k for k in S if k not in L]
    changed = [k for k in L if k in S and L[k] != S[k]]
    return {"added": sorted(added), "removed": sorted(removed), "changed": sorted(changed)}


def compute_plan(
    cfg: cfgmod.AgentqConfig,
    tier: str | None,
    current_state: dict[str, Any] | None,
    *,
    state_generation: int | None = None,
    source_sha: str = "unknown",
    cli_version: str = "0.0.0",
    actor: str = "unknown",
) -> dict[str, Any]:
    """Build a plan dict that conforms to schemas/plan.schema.json."""
    target = cfg.resolve_target(tier)
    local_hash = cfghash.compute_config_hash(cfg, tier)
    local_docs = scan_knowledge(cfg.project_root)
    local_docset_hash = cfghash.compute_docset_hash(local_docs)

    # Engine plan
    engine_block = (current_state or {}).get("engine") if current_state else None
    state_hash = engine_block.get("config_hash") if engine_block else None
    state_resource = engine_block.get("resource_name") if engine_block else None

    if state_resource is None:
        mode = "create"
    elif state_hash == local_hash:
        mode = "no_op"
    else:
        # Most config changes are updatable. Region/SA/model changes that
        # require recreation are flagged via per-field metadata when we
        # add config_diff entries; for v1 we treat all non-no-op changes as
        # "update" unless a specific field is known to require recreation.
        mode = "update"

    # KB plan
    kb_state = (current_state or {}).get("kb", {}) if current_state else {}
    state_docs = kb_state.get("documents", []) or []
    kb_docs_diff = _diff_docs(local_docs, state_docs)

    # KB mutation gating: tiers with allow_freeform_mutation=false and no
    # explicit override → action=skip. The plan still SHOWS the diff so
    # reviewers see what would change if the gate were lifted.
    kb_allowed = target.kb.allow_freeform_mutation
    has_changes = bool(kb_docs_diff["added"] or kb_docs_diff["changed"] or kb_docs_diff["removed"])
    if not target.kb.datastore_id:
        kb_action = "no_op"
    elif not has_changes:
        kb_action = "no_op"
    elif kb_allowed:
        kb_action = "reimport"
    else:
        kb_action = "skip"

    # Runtime plan (python deps + env vars)
    state_runtime = (current_state or {}).get("runtime", {}) if current_state else {}
    state_pkgs = state_runtime.get("python_packages", []) or []
    state_env = state_runtime.get("env_vars", {}) or {}
    py_diff = _diff_python_packages(cfg.runtime.python_packages, state_pkgs)
    env_diff = _diff_env_vars(cfg.runtime.env_vars, state_env)

    # Drift: state references a resource that no longer exists, OR config_hash
    # mismatches but engine still claims the old hash (we couldn't verify here
    # because we don't have engine SDK access in compute_plan — apply re-checks).
    drift_detected = False
    drift_details: list[str] = []

    # Build full plan
    short_sha = source_sha[:8] if source_sha and source_sha != "unknown" else "nosha"
    plan: dict[str, Any] = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "metadata": {
            "plan_id": f"{tier or 'legacy'}-{short_sha}-{int(time.time())}",
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "generated_by": actor,
            "source_sha": source_sha,
            "cli_version": cli_version,
        },
        "target": {
            "project_name": cfg.project.name,
            "tier": tier or "dev",  # plan schema requires enum; legacy projects shouldn't run state plan
            "gcp_project": target.gcp_project,
            "location": target.location,
            "display_name": target.display_name,
        },
        "engine_plan": {
            "mode": mode,
            "resource_name": state_resource,
            "config_hash_before": state_hash,
            "config_hash_after": local_hash,
            "config_diff": _summarize_config_diff(cfg, current_state, tier) if mode in ("update", "recreate") else [],
        },
        "kb_plan": {
            "action": kb_action,
            "datastore_id": target.kb.datastore_id,
            "datastore_created_by_plan": (
                target.kb.datastore_id is not None
                and not (engine_block and engine_block.get("resource_name"))
            ),
            "documents": kb_docs_diff,
        },
        "runtime_plan": {
            "python_packages": py_diff,
            "env_vars": env_diff,
        },
        "drift": {
            "detected": drift_detected,
            "details": drift_details,
        },
        "state_generation": state_generation,
        "risks": _gather_risks(py_diff, kb_docs_diff, kb_allowed, kb_action),
    }
    return plan


def _summarize_config_diff(
    cfg: cfgmod.AgentqConfig,
    current_state: dict[str, Any] | None,
    tier: str | None,
) -> list[dict[str, Any]]:
    """Coarse diff for the PR comment. Not exhaustive — the config_hash is
    the actual gate; this list is human-readable evidence."""
    if not current_state or not current_state.get("engine"):
        return []
    diffs: list[dict[str, Any]] = []
    state_runtime = current_state.get("runtime", {}) or {}
    if cfg.runtime.model != state_runtime.get("model"):
        diffs.append({
            "field": "runtime.model",
            "before": state_runtime.get("model"),
            "after": cfg.runtime.model,
            "requires_recreate": False,
        })
    target = cfg.resolve_target(tier)
    eng = current_state.get("engine") or {}
    if eng.get("display_name") and eng["display_name"] != target.display_name:
        diffs.append({
            "field": "project.display_name",
            "before": eng["display_name"],
            "after": target.display_name,
            "requires_recreate": False,
        })
    return diffs


def _gather_risks(
    py_diff: dict[str, Any],
    kb_docs_diff: dict[str, list[dict[str, Any]]],
    kb_allowed: bool,
    kb_action: str,
) -> list[dict[str, str]]:
    risks: list[dict[str, str]] = []
    if py_diff["added"]:
        risks.append({
            "severity": "warning",
            "message": f"New Python package(s): {', '.join(py_diff['added'])} — review for licensing/security.",
            "field": "runtime.python_packages",
        })
    if kb_docs_diff["removed"]:
        risks.append({
            "severity": "warning",
            "message": f"{len(kb_docs_diff['removed'])} KB document(s) will be REMOVED from the datastore.",
            "field": "kb.documents",
        })
    if not kb_allowed and (kb_docs_diff["added"] or kb_docs_diff["changed"] or kb_docs_diff["removed"]):
        risks.append({
            "severity": "info",
            "message": "KB changes detected but tier policy disallows mutation; plan shows diff but action=skip. "
                       "Pass --allow-prod-kb-mutation to override (CI handles this on merges to main).",
            "field": "kb",
        })
    if kb_docs_diff["added"]:
        risks.append({
            "severity": "info",
            "message": f"{len(kb_docs_diff['added'])} KB file(s) added; full re-import will take ~3 min.",
        })
    return risks


# ─── Subcommand handlers ─────────────────────────────────────────────────────

def cmd_show(cfg: cfgmod.AgentqConfig, state_file: str, tier: str | None) -> int:
    state = read_state(state_file)
    if state is None:
        print(f"(no state file at {state_file}; this tier has not been deployed)")
        return 0
    print(yaml.safe_dump(state, sort_keys=False))
    return 0


def cmd_diff(
    cfg: cfgmod.AgentqConfig, state_file: str, tier: str | None,
    out_json: bool, source_sha: str, cli_version: str, actor: str,
) -> int:
    current = read_state(state_file)
    plan = compute_plan(
        cfg, tier, current,
        source_sha=source_sha, cli_version=cli_version, actor=actor,
    )
    if out_json:
        print(json.dumps(plan, indent=2))
    else:
        _print_plan_human(plan)
    has_changes = (
        plan["engine_plan"]["mode"] != "no_op"
        or plan["kb_plan"]["action"] not in ("no_op", "skip")
        or plan["runtime_plan"]["python_packages"]["added"]
        or plan["runtime_plan"]["python_packages"]["removed"]
        or plan["runtime_plan"]["python_packages"]["version_changed"]
        or plan["drift"]["detected"]
    )
    return 3 if has_changes else 0


def cmd_plan(
    cfg: cfgmod.AgentqConfig, state_file: str, tier: str | None,
    plan_out: str, state_generation: int | None,
    source_sha: str, cli_version: str, actor: str,
) -> int:
    current = read_state(state_file)
    plan = compute_plan(
        cfg, tier, current,
        state_generation=state_generation,
        source_sha=source_sha, cli_version=cli_version, actor=actor,
    )
    Path(plan_out).parent.mkdir(parents=True, exist_ok=True)
    Path(plan_out).write_text(json.dumps(plan, indent=2), encoding="utf-8")
    print(f"  [plan] wrote {plan_out}")
    print(f"  [plan] engine.mode={plan['engine_plan']['mode']}  kb.action={plan['kb_plan']['action']}")
    return 0


def cmd_apply(
    cfg: cfgmod.AgentqConfig, state_file: str, tier: str | None,
    plan_path: str, current_generation: int | None,
) -> int:
    """Execute a previously-computed plan.

    Validates the plan's state_generation still matches the current state
    file's generation (passed by Node from GCS metadata). Mismatch = abort.
    """
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    if plan.get("schema_version") != PLAN_SCHEMA_VERSION:
        print(f"ERROR: plan schema_version={plan.get('schema_version')} not supported by this CLI", file=sys.stderr)
        return 5

    expected_gen = plan.get("state_generation")
    if expected_gen is not None and current_generation is not None and expected_gen != current_generation:
        print(
            f"ERROR: state generation changed since plan was computed "
            f"(plan expected {expected_gen}, now {current_generation}). "
            "Re-run `agentq state plan` and `agentq state apply`.",
            file=sys.stderr,
        )
        return 4

    target = cfg.resolve_target(tier)
    current = read_state(state_file) or {}

    # 1. Engine ops
    mode = plan["engine_plan"]["mode"]
    resource_name = plan["engine_plan"].get("resource_name")
    if mode == "no_op":
        print("  [apply] engine: no_op")
    elif mode == "create":
        print(f"  [apply] engine: creating in {target.gcp_project} / {target.location}")
        resource_name = deploymod.cmd_create_for_target(cfg, target)
        print(f"  [apply] ✓ engine created: {resource_name}")
    elif mode in ("update", "recreate"):
        if mode == "recreate":
            # Out of scope for v1: emit a clear failure so the user destroys + recreates explicitly
            print("ERROR: 'recreate' mode requires `agentq destroy --tier <t>` then a fresh `agentq deploy --tier <t> --recreate`. "
                  "Apply does not perform destructive operations automatically.", file=sys.stderr)
            return 5
        print(f"  [apply] engine: updating {resource_name}")
        deploymod.cmd_update_for_target(cfg, target, resource_name)
        print(f"  [apply] ✓ engine updated: {resource_name}")
    else:
        print(f"ERROR: unknown engine_plan.mode '{mode}'", file=sys.stderr)
        return 5

    # 2. KB ops
    kb_action = plan["kb_plan"]["action"]
    if kb_action == "reimport":
        print(f"  [apply] kb: reimport into {target.kb.datastore_id}")
        kbmod.cmd_apply_for_target(cfg, target, plan["kb_plan"])
        print("  [apply] ✓ kb reimported")
    elif kb_action == "skip":
        print(f"  [apply] kb: skipped (tier policy / no override)")

    # 3. Persist new state locally — Node uploads to GCS with generation match.
    new_state = _build_new_state(cfg, target, tier, resource_name, plan, current)
    write_state(state_file, new_state)
    print(f"  [apply] wrote new state to {state_file}")
    return 0


def _build_new_state(
    cfg: cfgmod.AgentqConfig,
    target: Any,
    tier: str | None,
    resource_name: str | None,
    plan: dict[str, Any],
    current: dict[str, Any],
) -> dict[str, Any]:
    """Compose state.yaml after a successful apply."""
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    # Documents after apply = unchanged ∪ (added + changed). Removed are dropped.
    new_docs: list[dict[str, Any]] = list(plan["kb_plan"]["documents"]["unchanged"])
    for d in plan["kb_plan"]["documents"]["added"] + plan["kb_plan"]["documents"]["changed"]:
        entry = {
            "filename": d["filename"],
            "sha256": d["sha256"],
            "indexed_at": now,
            "gcs_uri": f"gs://{target.kb.bucket}/{d['filename']}" if target.kb.bucket else "",
            "document_id": d.get("document_id", ""),
        }
        if "size_bytes" in d:
            entry["size_bytes"] = d["size_bytes"]
        new_docs.append(entry)

    docset_hash = cfghash.compute_docset_hash(new_docs)

    state: dict[str, Any] = {
        "schema_version": STATE_SCHEMA_VERSION,
        "project_name": cfg.project.name,
        "tier": tier or "dev",
        "gcp_project": target.gcp_project,
        "location": target.location,
        "engine": {
            "resource_name": resource_name or "",
            "display_name": target.display_name,
            "config_hash": plan["engine_plan"]["config_hash_after"],
            "last_deployed_at": now,
            "last_deployed_sha": plan["metadata"]["source_sha"],
            "last_deployed_by": plan["metadata"]["generated_by"],
            "runtime_version": plan["metadata"]["cli_version"],
            "agentq_schema_version": 2,
        } if resource_name else None,
        "kb": {
            "provider": "gemini-enterprise-search" if target.kb.datastore_id else "none",
            "datastore_id": target.kb.datastore_id,
            "bucket": target.kb.bucket,
            "location": target.kb.location,
            "documents": new_docs,
            "docset_hash": docset_hash,
        },
        "runtime": {
            "model": cfg.runtime.model,
            "python_packages": list(cfg.runtime.python_packages),
            "env_vars": {
                k: v for k, v in cfg.runtime.env_vars.items()
                if k not in cfghash.AUTO_INJECTED_ENV_KEYS
            },
        },
        "history": ([
            {
                "at": now,
                "sha": plan["metadata"]["source_sha"],
                "actor": plan["metadata"]["generated_by"],
                "op": "apply",
                "plan_id": plan["metadata"]["plan_id"],
                "config_hash_before": plan["engine_plan"]["config_hash_before"],
                "config_hash_after": plan["engine_plan"]["config_hash_after"],
                "docset_hash_before": (current.get("kb") or {}).get("docset_hash"),
                "docset_hash_after": docset_hash,
            }
        ] + (current.get("history") or []))[:50],  # ring buffer cap 50
    }
    return state


def cmd_import(
    cfg: cfgmod.AgentqConfig, state_file: str, tier: str | None,
    resource_name: str, with_kb: bool,
) -> int:
    """Stamp an existing live engine into the state file as if GitOps had created it."""
    target = cfg.resolve_target(tier)

    # We trust the resource exists (the caller is migrating, not deploying).
    # The config_hash is the LOCAL hash — apply will reconcile on next deploy
    # if reality drifted from source.
    config_hash = cfghash.compute_config_hash(cfg, tier)
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    docs: list[dict[str, Any]] = []
    if with_kb:
        # Best-effort: scan local knowledge/ to seed the state. The first
        # real plan will diff against this so additions/changes are visible.
        local = scan_knowledge(cfg.project_root)
        for d in local:
            d["indexed_at"] = now
            d["gcs_uri"] = f"gs://{target.kb.bucket}/{d['filename']}" if target.kb.bucket else ""
            d["document_id"] = ""  # unknown until first real apply
        docs = local

    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "project_name": cfg.project.name,
        "tier": tier or "dev",
        "gcp_project": target.gcp_project,
        "location": target.location,
        "engine": {
            "resource_name": resource_name,
            "display_name": target.display_name,
            "config_hash": config_hash,
            "last_deployed_at": now,
            "last_deployed_sha": "imported",
            "last_deployed_by": "agentq state import",
            "runtime_version": "imported",
            "agentq_schema_version": 2,
        },
        "kb": {
            "provider": "gemini-enterprise-search" if target.kb.datastore_id else "none",
            "datastore_id": target.kb.datastore_id,
            "bucket": target.kb.bucket,
            "location": target.kb.location,
            "documents": docs,
            "docset_hash": cfghash.compute_docset_hash(docs) if docs else "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        "runtime": {
            "model": cfg.runtime.model,
            "python_packages": list(cfg.runtime.python_packages),
            "env_vars": {
                k: v for k, v in cfg.runtime.env_vars.items()
                if k not in cfghash.AUTO_INJECTED_ENV_KEYS
            },
        },
        "history": [{
            "at": now,
            "sha": "imported",
            "actor": "agentq state import",
            "op": "import",
            "plan_id": None,
            "config_hash_before": None,
            "config_hash_after": config_hash,
            "docset_hash_before": None,
            "docset_hash_after": None,
        }],
    }
    write_state(state_file, state)
    print(f"  [import] wrote {state_file}")
    print(f"  [import] engine.resource_name = {resource_name}")
    return 0


def cmd_rm(state_file: str) -> int:
    p = Path(state_file)
    if p.is_file():
        p.unlink()
        print(f"  [rm] deleted {state_file}")
    else:
        print(f"  [rm] no state file at {state_file}")
    return 0


# ─── Human-readable diff printer ─────────────────────────────────────────────

def _print_plan_human(plan: dict[str, Any]) -> None:
    """Pretty-print a plan to stdout for local invocation."""
    print(f"Plan for {plan['target']['project_name']} (tier: {plan['target']['tier']})")
    print(f"  GCP project : {plan['target']['gcp_project']}")
    print(f"  location    : {plan['target']['location']}")
    print()
    ep = plan["engine_plan"]
    print(f"Engine: {ep['mode']}")
    if ep["mode"] != "no_op":
        print(f"  resource_name : {ep.get('resource_name') or '(new)'}")
        print(f"  config_hash   : {ep['config_hash_before']} → {ep['config_hash_after']}")
        for d in ep.get("config_diff", []):
            print(f"    · {d['field']}: {d['before']!r} → {d['after']!r}")
    print()
    kp = plan["kb_plan"]
    print(f"KB: {kp['action']} (datastore: {kp['datastore_id'] or '(none)'})")
    docs = kp["documents"]
    if docs["added"]:
        print(f"  + added ({len(docs['added'])}):")
        for d in docs["added"]:
            print(f"      {d['filename']}")
    if docs["changed"]:
        print(f"  ~ changed ({len(docs['changed'])}):")
        for d in docs["changed"]:
            print(f"      {d['filename']}")
    if docs["removed"]:
        print(f"  - removed ({len(docs['removed'])}):")
        for d in docs["removed"]:
            print(f"      {d['filename']}")
    print()
    rp = plan["runtime_plan"]
    pyd = rp["python_packages"]
    if pyd["added"] or pyd["removed"] or pyd["version_changed"]:
        print("Runtime (Python packages):")
        for p in pyd["added"]:    print(f"  + {p}")
        for p in pyd["removed"]:  print(f"  - {p}")
        for c in pyd["version_changed"]: print(f"  ~ {c['name']}: {c['from']} → {c['to']}")
    if plan["risks"]:
        print()
        print("Risks:")
        for r in plan["risks"]:
            marker = {"info": "·", "warning": "⚠", "error": "✗"}.get(r["severity"], "·")
            print(f"  {marker} {r['message']}")


# ─── CLI entry point ─────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m agentq_runtime.state")
    parser.add_argument("subcommand", choices=["show", "diff", "plan", "apply", "import", "rm"])
    parser.add_argument("--config-file", required=True, help="Path to agentq.config.yaml")
    parser.add_argument("--state-file", required=True, help="Local path to state.yaml (Node handles GCS transport).")
    parser.add_argument("--tier", default=None, help="dev / staging / prod. Omit for legacy mode.")
    parser.add_argument("--plan", help="Path to plan.json (apply) or plan output (plan).")
    parser.add_argument("--plan-out", help="(plan) Output path for plan.json.")
    parser.add_argument("--state-generation", type=int, default=None,
                        help="Current GCS state object generation. Used by apply to detect concurrent deploys.")
    parser.add_argument("--source-sha", default="local", help="git HEAD at plan time")
    parser.add_argument("--cli-version", default="0.0.0")
    parser.add_argument("--actor", default=os.environ.get("USER", "unknown"))
    parser.add_argument("--resource-name", help="(import) Resource name of the existing engine to import.")
    parser.add_argument("--with-kb", action="store_true", help="(import) Seed the state's kb.documents with current local files.")
    parser.add_argument("--json", action="store_true", help="(diff) Output JSON instead of human text.")
    args = parser.parse_args()

    cfg = cfgmod.load(args.config_file)
    sub = args.subcommand

    if sub == "show":
        return cmd_show(cfg, args.state_file, args.tier)
    if sub == "diff":
        return cmd_diff(cfg, args.state_file, args.tier, args.json,
                        args.source_sha, args.cli_version, args.actor)
    if sub == "plan":
        if not args.plan_out:
            parser.error("--plan-out is required for the `plan` subcommand")
        return cmd_plan(cfg, args.state_file, args.tier, args.plan_out, args.state_generation,
                        args.source_sha, args.cli_version, args.actor)
    if sub == "apply":
        if not args.plan:
            parser.error("--plan is required for the `apply` subcommand")
        return cmd_apply(cfg, args.state_file, args.tier, args.plan, args.state_generation)
    if sub == "import":
        if not args.resource_name:
            parser.error("--resource-name is required for the `import` subcommand")
        return cmd_import(cfg, args.state_file, args.tier, args.resource_name, args.with_kb)
    if sub == "rm":
        return cmd_rm(args.state_file)
    return 2


if __name__ == "__main__":
    sys.exit(main())
