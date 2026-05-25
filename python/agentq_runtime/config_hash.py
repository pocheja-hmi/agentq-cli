"""Mirror of src/lib/config-hash.ts. Must produce IDENTICAL hashes for
the same logical config — drift detection asymmetry would be catastrophic.

A unit test in tests/test_hash_parity.py feeds the same fixture through both
implementations and asserts equal output. If you change one side, change the
other side in the same commit, and update the fixture if needed.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from . import config as cfgmod

# Auto-injected env vars from config.py::load() — never contribute to hash.
AUTO_INJECTED_ENV_KEYS = frozenset({
    "MODEL",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "KB_DATASTORE",
})


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
