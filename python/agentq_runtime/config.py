"""Single point of truth for reading and resolving agentq.config.yaml.

The YAML schema is enforced in the Node CLI via zod. This module trusts the
shape but validates the few invariants Python actually needs (presence of
required keys) so a hand-edited file produces a useful error message.
"""
from __future__ import annotations

import importlib
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml


REQUIRED_TOP_LEVEL = ("project", "agent", "deployment", "runtime")
RESERVED_ENV_NAMES = frozenset({
    "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS", "K_SERVICE", "K_REVISION",
    "K_CONFIGURATION", "PORT",
})


@dataclass
class Project:
    name: str
    package: str
    description: str
    display_name: str


@dataclass
class Agent:
    pattern: str
    entry_module: str
    entry_symbol: str = "root_agent"
    sub_agents: int = 0


@dataclass
class Deployment:
    gcp_project: str
    location: str
    staging_bucket: str
    service_account: Optional[str] = None
    resource_name: Optional[str] = None


@dataclass
class Runtime:
    model: str = "gemini-2.5-flash"
    python_packages: list[str] = field(default_factory=list)
    extra_packages: list[str] = field(default_factory=list)
    env_vars: dict[str, str] = field(default_factory=dict)


@dataclass
class KnowledgeBase:
    provider: str = "none"
    datastore_id: Optional[str] = None
    bucket: Optional[str] = None
    location: str = "global"


@dataclass
class Observability:
    tracing: bool = True
    level: str = "standard"


@dataclass
class Hooks:
    pre_deploy: Optional[str] = None
    post_deploy: Optional[str] = None


@dataclass
class AgentqConfig:
    project: Project
    agent: Agent
    deployment: Deployment
    runtime: Runtime
    knowledge_base: KnowledgeBase
    observability: Observability
    hooks: Hooks
    project_root: Path

    @property
    def datastore_resource(self) -> Optional[str]:
        kb = self.knowledge_base
        if kb.provider != "vertex-ai-search" or not kb.datastore_id:
            return None
        return (
            f"projects/{self.deployment.gcp_project}"
            f"/locations/{kb.location}"
            f"/collections/default_collection"
            f"/dataStores/{kb.datastore_id}"
        )


def _coerce(d: Any, cls: type) -> Any:
    if not isinstance(d, dict):
        return cls()  # type: ignore[call-arg]
    fields = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
    return cls(**{k: v for k, v in d.items() if k in fields})


_INTERP = re.compile(r"\$\{([\w.]+)\}")


def _interp_value(value: str, ctx: dict[str, Any]) -> str:
    def lookup(path: str) -> str:
        cur: Any = ctx
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return ""
            cur = cur[part]
        return str(cur)
    return _INTERP.sub(lambda m: lookup(m.group(1)), value)


def _resolve_env_vars(env: dict[str, str], cfg: dict[str, Any]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for k, v in env.items():
        if k in RESERVED_ENV_NAMES:
            print(f"  [config] dropping reserved env var: {k}", file=sys.stderr)
            continue
        if not isinstance(v, str):
            v = str(v)
        resolved[k] = _interp_value(v, cfg)
    return resolved


def load(config_file: str | os.PathLike[str]) -> AgentqConfig:
    p = Path(config_file).resolve()
    if not p.is_file():
        raise FileNotFoundError(f"agentq.config.yaml not found at {p}")
    with p.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    for key in REQUIRED_TOP_LEVEL:
        if key not in raw:
            raise ValueError(f"agentq.config.yaml: missing top-level key '{key}'")

    runtime_raw = dict(raw.get("runtime") or {})
    env_vars = dict(runtime_raw.pop("env_vars", {}) or {})
    runtime_raw["env_vars"] = _resolve_env_vars(env_vars, raw)
    if not runtime_raw.get("python_packages"):
        runtime_raw["python_packages"] = [
            "google-adk>=1.27.0",
            "google-genai>=1.0.0",
        ]

    cfg = AgentqConfig(
        project=_coerce(raw.get("project"), Project),
        agent=_coerce(raw.get("agent"), Agent),
        deployment=_coerce(raw.get("deployment"), Deployment),
        runtime=_coerce(runtime_raw, Runtime),
        knowledge_base=_coerce(raw.get("knowledge_base"), KnowledgeBase),
        observability=_coerce(raw.get("observability"), Observability),
        hooks=_coerce(raw.get("hooks"), Hooks),
        project_root=p.parent,
    )

    # Always inject MODEL and the VertexAI flag if absent.
    cfg.runtime.env_vars.setdefault("MODEL", cfg.runtime.model)
    cfg.runtime.env_vars.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    if cfg.knowledge_base.provider == "vertex-ai-search" and cfg.datastore_resource:
        cfg.runtime.env_vars.setdefault("KB_DATASTORE", cfg.datastore_resource)

    # extra_packages is always extended with the project's main package
    # at deploy time (see agentq_runtime/deploy.py::_normalize_extra_packages).
    # Don't auto-fill it here — keeps the YAML clean and avoids redundant
    # entries that confuse users.

    return cfg


def update_resource_name(config_file: str | os.PathLike[str], resource_name: str) -> None:
    p = Path(config_file)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    raw.setdefault("deployment", {})["resource_name"] = resource_name
    p.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")


def import_root_agent(cfg: AgentqConfig):
    """Import the project's package (sys.path was set by the CLI) and resolve the agent symbol."""
    sys.path.insert(0, str((cfg.project_root / "src").resolve()))
    module = importlib.import_module(cfg.agent.entry_module)
    if not hasattr(module, cfg.agent.entry_symbol):
        raise AttributeError(
            f"{cfg.agent.entry_module} has no attribute {cfg.agent.entry_symbol}"
        )
    return getattr(module, cfg.agent.entry_symbol)
