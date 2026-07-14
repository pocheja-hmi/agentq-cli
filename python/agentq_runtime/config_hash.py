"""Mirror of src/lib/config-hash.ts. Must produce IDENTICAL hashes for
the same logical config — drift detection asymmetry would be catastrophic.

A unit test in tests/test_hash_parity.py feeds the same fixture through both
implementations and asserts equal output. If you change one side, change the
other side in the same commit, and update the fixture if needed.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from . import config as cfgmod

# Auto-injected env vars from config.py::load() — never contribute to hash.
AUTO_INJECTED_ENV_KEYS = frozenset({
    "MODEL",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "KB_DATASTORE",
})

# Filesystem entries that never affect the deployed tarball.
_SRC_EXCLUDED_DIRS = frozenset({
    "__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", ".venv", "node_modules",
})
_SRC_EXCLUDED_SUFFIXES = (".pyc", ".pyo")
_SRC_EXCLUDED_FILENAMES = frozenset({".DS_Store"})


def _canonical(value: Any) -> str:
    """Stable JSON: keys sorted, nulls excluded, no whitespace. Must match
    the TS implementation exactly. Python's `json.dumps(sort_keys=True)`
    doesn't strip nulls or guarantee compact separators by default — we
    build it ourselves to keep parity precise.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        # JSON.stringify uses the same rules as Python for these.
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts: list[str] = []
        for k in keys:
            v = value[k]
            if v is None:
                # Match TS behaviour: skip null/undefined entries entirely.
                continue
            parts.append(json.dumps(k) + ":" + _canonical(v))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"_canonical: unsupported type {type(value).__name__}")


def _iter_package_files(root: Path) -> list[tuple[str, str]]:
    """Walk `root` (a package directory under <project_root>/src/) and return
    a list of ``(relpath, sha256_hex)`` pairs for every shippable file.

    `relpath` is rooted at `root.parent` so the recorded path is
    ``<package>/<file>`` — matching the layout inside the deploy tarball.
    """
    if not root.is_dir():
        return []
    base = root.parent
    out: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in _SRC_EXCLUDED_DIRS)
        for fn in sorted(filenames):
            if fn in _SRC_EXCLUDED_FILENAMES:
                continue
            if fn.endswith(_SRC_EXCLUDED_SUFFIXES):
                continue
            full = Path(dirpath) / fn
            try:
                data = full.read_bytes()
            except OSError:
                continue
            sha = hashlib.sha256(data).hexdigest()
            rel = full.relative_to(base).as_posix()
            out.append((rel, sha))
    return out


def _source_roots(cfg: cfgmod.AgentqConfig) -> list[Path]:
    """Return the package directories that the deploy tarball will contain.

    Mirrors deploy.py::_normalize_extra_packages so the hash covers exactly
    what ships. `cfg.project_root` must point at the directory holding
    `src/<package>/`.
    """
    project_root = getattr(cfg, "project_root", None)
    if project_root is None:
        return []
    src_dir = Path(project_root) / "src"
    roots: list[Path] = []
    main_pkg = (cfg.project.package or "").strip()
    seen: set[str] = set()
    if main_pkg:
        main_root = src_dir / main_pkg
        if main_root.is_dir():
            roots.append(main_root)
            seen.add(main_pkg)
    for ep in (cfg.runtime.extra_packages or []):
        s = (ep or "").strip()
        if not s:
            continue
        if os.path.isabs(s):
            p = Path(s)
            key = str(p)
        else:
            if s.startswith("./"):
                s = s[2:]
            if s.startswith("src/"):
                s = s[4:]
            p = src_dir / s
            key = os.path.basename(s.rstrip("/")) or s
        if key in seen:
            continue
        if p.is_dir():
            roots.append(p)
            seen.add(key)
    return roots


def _source_tree_hash(cfg: cfgmod.AgentqConfig) -> str:
    """Hash the contents of every shippable package directory.

    Returns ``sha256:<hex>`` over a canonical list of
    ``{"path": <relpath>, "sha256": <file_hex>}`` entries sorted by path.
    Returns an empty string when no packages were found (e.g. fixture
    configs with no `project_root` on disk) — kept stable so the parity
    test fixture has a deterministic empty case.
    """
    entries: list[tuple[str, str]] = []
    for r in _source_roots(cfg):
        entries.extend(_iter_package_files(r))
    if not entries:
        return ""
    entries.sort(key=lambda pair: pair[0])
    payload = [{"path": p, "sha256": s} for p, s in entries]
    serial = _canonical(payload)
    return "sha256:" + hashlib.sha256(serial.encode("utf-8")).hexdigest()


def _deployed_view(cfg: cfgmod.AgentqConfig, tier: str | None) -> dict[str, Any]:
    """Build the "what's deployed" subset of the config.

    Mirrors deployedView() in src/lib/config-hash.ts. Every field included
    here is something a change to which should mark the engine as drifted.
    """
    env_clean: dict[str, str] = {
        k: v for k, v in (cfg.runtime.env_vars or {}).items()
        if k not in AUTO_INJECTED_ENV_KEYS
    }

    tier_block: dict[str, Any] | None = None
    if tier and tier in cfg.tiers:
        t = cfg.tiers[tier]
        tier_block = {
            "gcp_project": t.gcp_project,
            "location": t.location,
            "runtime_service_account": t.runtime_service_account,
            "display_name_suffix": t.display_name_suffix,
            "labels": dict(t.labels),
            "kb": {
                "datastore_id": t.kb.datastore_id,
                "bucket": t.kb.bucket,
                "location": t.kb.location,
            },
        }

    return {
        "project": {
            "name": cfg.project.name,
            "package": cfg.project.package,
            "display_name": cfg.project.display_name,
        },
        # Folds the package source tree into the drift token so a code-only
        # change (no YAML edit) still produces a fresh hash and triggers a
        # redeploy. Empty string when no project_root is available (legacy
        # fixture configs); production calls always have one.
        "source_tree_hash": _source_tree_hash(cfg),
        "agent": {
            "pattern": cfg.agent.pattern,
            "entry_module": cfg.agent.entry_module,
            "entry_symbol": cfg.agent.entry_symbol,
            "sub_agents": cfg.agent.sub_agents,
        },
        "runtime": {
            "model": cfg.runtime.model,
            "python_packages": sorted(cfg.runtime.python_packages or []),
            "extra_packages": sorted(cfg.runtime.extra_packages or []),
            "env_vars": env_clean,
        },
        "tier": tier,
        "tier_block": tier_block,
        "legacy_deployment": None if tier_block else {
            "gcp_project": cfg.deployment.gcp_project,
            "location": cfg.deployment.location,
            "service_account": cfg.deployment.service_account,
        },
        "legacy_kb": None if tier_block else {
            "provider": cfg.knowledge_base.provider,
            "datastore_id": cfg.knowledge_base.datastore_id,
            "bucket": cfg.knowledge_base.bucket,
            "location": cfg.knowledge_base.location,
        },
    }


def compute_config_hash(cfg: cfgmod.AgentqConfig, tier: str | None) -> str:
    """Compute the drift token. Format: ``sha256:<64-hex>``."""
    view = _deployed_view(cfg, tier)
    serial = _canonical(view)
    digest = hashlib.sha256(serial.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def compute_docset_hash(documents: list[dict[str, str]]) -> str:
    """Hash a sorted document set. Used for kb.docset_hash.

    Each document is expected to have at least ``filename`` and ``sha256`` keys.
    Extra fields are ignored.
    """
    sorted_docs = sorted(documents, key=lambda d: d["filename"])
    minimal = [
        {"filename": d["filename"], "sha256": d["sha256"]}
        for d in sorted_docs
    ]
    serial = _canonical(minimal)
    digest = hashlib.sha256(serial.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"
