"""Single point of truth for reading and resolving agentq.config.yaml.

The YAML schema is enforced in the Node CLI via zod. This module trusts the
shape but validates the few invariants Python actually needs (presence of
required keys) so a hand-edited file produces a useful error message.

Schema versions:
    1 — legacy single-tier layout. `deployment` and `knowledge_base` are the
        sole source of truth.
    2 — adds optional `gitops` and `tiers` blocks. When gitops.enabled=true,
        the `tiers.*` block is consulted for tier-specific GCP / KB info.
        For backwards-compatibility, `load()` synthesizes a `deployment` block
        from the default tier when absent, so legacy callers keep working.
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


REQUIRED_TOP_LEVEL = ("project", "agent", "runtime")  # deployment is now synthesizable
RESERVED_ENV_NAMES = frozenset({
    "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS", "K_SERVICE", "K_REVISION",
    "K_CONFIGURATION", "PORT",
})
VALID_TIERS = frozenset({"dev", "staging", "prod"})

# Canonical KB provider id is 'gemini-enterprise-search'. The legacy name
# 'vertex-ai-search' is accepted on read (old YAMLs / GCS state files keep
# working) and normalised at load time. New writes always emit the canonical
# form. Keep this in sync with src/lib/config.ts::LEGACY_KB_PROVIDER_ALIASES.
KB_PROVIDER_ALIASES = {
    "vertex-ai-search": "gemini-enterprise-search",
}


def _normalize_kb_provider(value):
    """Map legacy provider names to canonical. Pass-through for anything else."""
    if isinstance(value, str) and value in KB_PROVIDER_ALIASES:
        return KB_PROVIDER_ALIASES[value]
    return value


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
    """Legacy single-datastore block (schema v1)."""
    provider: str = "none"
    datastore_id: Optional[str] = None
    bucket: Optional[str] = None
    location: str = "global"


@dataclass
class TierKb:
    """Per-tier KB block under tiers.<t>.kb (schema v2)."""
    datastore_id: Optional[str] = None
    bucket: Optional[str] = None
    location: str = "global"
    allow_freeform_mutation: bool = False


@dataclass
class Tier:
    """One entry under tiers.<name> (schema v2)."""
    gcp_project: str
    location: str = "us-central1"
    staging_bucket: str = ""
    state_bucket: str = ""
    deployer_service_account: Optional[str] = None
    runtime_service_account: Optional[str] = None
    display_name_suffix: str = ""
    labels: dict[str, str] = field(default_factory=dict)
    kb: TierKb = field(default_factory=TierKb)


@dataclass
class Gitops:
    """gitops:* block (schema v2)."""
    enabled: bool = False
    default_tier: str = "dev"
    branch_map: dict[str, str] = field(default_factory=lambda: {
        "dev": "dev", "staging": "staging", "prod": "main",
    })
    state_path_template: str = "agentq/{project_name}/{tier}/state.yaml"


@dataclass
class Observability:
    tracing: bool = True
    level: str = "standard"


@dataclass
class Hooks:
    pre_deploy: Optional[str] = None
    post_deploy: Optional[str] = None


# Resolved view used by deploy/destroy/kb when running in tier mode. This is
# the *flattened* shape — no more reaching into cfg.tiers[t] from individual
# command modules. Built by AgentqConfig.resolve_target().
@dataclass
class ResolvedTarget:
    tier: Optional[str]                 # None ⇒ legacy mode
    gcp_project: str
    location: str
    staging_bucket: str
    state_bucket: Optional[str]         # None ⇒ legacy mode
    deployer_service_account: Optional[str]
    runtime_service_account: Optional[str]
    display_name: str                   # composed: project.display_name + tier suffix
    labels: dict[str, str]
    kb: TierKb
    # The datastore resource path for this target, computed lazily.
    datastore_resource: Optional[str] = None


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
    # v2 additions — optional. None on v1 configs.
    gitops: Optional[Gitops] = None
    tiers: dict[str, Tier] = field(default_factory=dict)

    # ─── Legacy datastore resolver (schema v1) ──────────────────────────
    @property
    def datastore_resource(self) -> Optional[str]:
        kb = self.knowledge_base
        if kb.provider != "gemini-enterprise-search" or not kb.datastore_id:
            return None
        return (
            f"projects/{self.deployment.gcp_project}"
            f"/locations/{kb.location}"
            f"/collections/default_collection"
            f"/dataStores/{kb.datastore_id}"
        )

    # ─── Tier-aware accessors (schema v2) ────────────────────────────────
    def kb_for(self, tier: Optional[str]) -> TierKb:
        """Return the KB config for a tier, or a TierKb derived from the
        legacy `knowledge_base` block when tier is None or unknown."""
        if tier and tier in self.tiers:
            return self.tiers[tier].kb
        # Legacy fallback — wrap KnowledgeBase as TierKb so callers have one
        # shape to consume.
        return TierKb(
            datastore_id=self.knowledge_base.datastore_id,
            bucket=self.knowledge_base.bucket,
            location=self.knowledge_base.location,
            allow_freeform_mutation=True,  # legacy mode never gated
        )

    def datastore_resource_for(self, tier: Optional[str]) -> Optional[str]:
        """Full Gemini Enterprise Search datastore path for a tier (or legacy)."""
        kb = self.kb_for(tier)
        if not kb.datastore_id:
            return None
        gcp = self.tiers[tier].gcp_project if (tier and tier in self.tiers) else self.deployment.gcp_project
        return (
            f"projects/{gcp}"
            f"/locations/{kb.location}"
            f"/collections/default_collection"
            f"/dataStores/{kb.datastore_id}"
        )

    def resolve_target(self, tier: Optional[str]) -> ResolvedTarget:
        """Flatten config into a ResolvedTarget for deploy/destroy/kb.

        Coexistence rules:
          1. Tier explicit  → use cfg.tiers[tier]. Error if missing.
          2. GitOps enabled → use cfg.tiers[gitops.default_tier].
          3. Otherwise      → use legacy cfg.deployment + cfg.knowledge_base.
        """
        if tier is None and self.gitops and self.gitops.enabled:
            tier = self.gitops.default_tier
        if tier is not None:
            if tier not in VALID_TIERS:
                raise ValueError(f"Unknown tier: {tier!r}. Must be one of {sorted(VALID_TIERS)}.")
            if tier not in self.tiers:
                raise ValueError(
                    f"tiers.{tier} is not defined in agentq.config.yaml. "
                    f"Define it or pick a tier that exists: {sorted(self.tiers.keys())}"
                )
            t = self.tiers[tier]
            return ResolvedTarget(
                tier=tier,
                gcp_project=t.gcp_project,
                location=t.location,
                staging_bucket=t.staging_bucket,
                state_bucket=t.state_bucket,
                deployer_service_account=t.deployer_service_account,
                runtime_service_account=t.runtime_service_account,
                display_name=self.project.display_name + t.display_name_suffix,
                labels=dict(t.labels),
                kb=t.kb,
                datastore_resource=self.datastore_resource_for(tier),
            )
        # Legacy fallback.
        return ResolvedTarget(
            tier=None,
            gcp_project=self.deployment.gcp_project,
            location=self.deployment.location,
            staging_bucket=self.deployment.staging_bucket,
            state_bucket=None,
            deployer_service_account=None,
            runtime_service_account=self.deployment.service_account,
            display_name=self.project.display_name,
            labels={},
            kb=self.kb_for(None),
            datastore_resource=self.datastore_resource,
        )


def _coerce(d: Any, cls: type) -> Any:
    if not isinstance(d, dict):
        return cls()  # type: ignore[call-arg]
    fields = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
    return cls(**{k: v for k, v in d.items() if k in fields})


def _coerce_tier(d: Any) -> Tier:
    """Tier has nested kb; needs special coercion."""
    if not isinstance(d, dict):
        return Tier(gcp_project="")
    kb_dict = d.get("kb", {}) or {}
    tier = _coerce({k: v for k, v in d.items() if k != "kb"}, Tier)
    tier.kb = _coerce(kb_dict, TierKb)
    return tier


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


def _synthesize_deployment_from_tier(raw: dict[str, Any]) -> dict[str, Any]:
    """If `deployment` is missing but `gitops.enabled=true`, synthesize one
    from the default tier so legacy code paths keep working.

    Mirrors src/lib/config.ts::synthesizeDeploymentFromTier on the Node side
    — they must produce equivalent results from the same YAML.
    """
    if raw.get("deployment"):
        return raw
    gitops = raw.get("gitops") or {}
    tiers = raw.get("tiers") or {}
    if not gitops.get("enabled") or not tiers:
        return raw
    default_tier_name = gitops.get("default_tier") or "dev"
    tier = tiers.get(default_tier_name)
    if not tier:
        return raw
    raw["deployment"] = {
        "gcp_project":    tier.get("gcp_project", ""),
        "location":       tier.get("location", "us-central1"),
        "staging_bucket": tier.get("staging_bucket", ""),
        "service_account": tier.get("runtime_service_account"),
        "resource_name":  None,
    }
    return raw


def load(config_file: str | os.PathLike[str]) -> AgentqConfig:
    p = Path(config_file).resolve()
    if not p.is_file():
        raise FileNotFoundError(f"agentq.config.yaml not found at {p}")
    with p.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}

    # v2 compat: derive a deployment block from the default tier if missing.
    raw = _synthesize_deployment_from_tier(raw)

    for key in REQUIRED_TOP_LEVEL:
        if key not in raw:
            raise ValueError(f"agentq.config.yaml: missing top-level key '{key}'")
    if "deployment" not in raw:
        raise ValueError(
            "agentq.config.yaml: missing `deployment:` block. Either define it "
            "or set gitops.enabled=true with tiers.* (a deployment block is "
            "synthesized from the default tier)."
        )

    runtime_raw = dict(raw.get("runtime") or {})
    env_vars = dict(runtime_raw.pop("env_vars", {}) or {})
    runtime_raw["env_vars"] = _resolve_env_vars(env_vars, raw)
    if not runtime_raw.get("python_packages"):
        runtime_raw["python_packages"] = [
            "google-adk>=1.27.0",
            "google-genai>=1.0.0",
        ]

    # Parse tiers + gitops if present.
    tiers_raw = raw.get("tiers") or {}
    tiers_parsed: dict[str, Tier] = {
        name: _coerce_tier(value) for name, value in tiers_raw.items() if name in VALID_TIERS
    }
    gitops_raw = raw.get("gitops")
    gitops_parsed = _coerce(gitops_raw, Gitops) if gitops_raw else None

    # Normalize legacy KB provider names BEFORE coercion so the dataclass
    # always holds the canonical string. Old YAMLs with `provider: vertex-ai-search`
    # keep working; new writes always emit `gemini-enterprise-search`.
    kb_raw = raw.get("knowledge_base") or {}
    if isinstance(kb_raw, dict) and "provider" in kb_raw:
        kb_raw["provider"] = _normalize_kb_provider(kb_raw["provider"])
    for tier_dict in tiers_raw.values():
        if isinstance(tier_dict, dict):
            kb_tier = tier_dict.get("kb")
            if isinstance(kb_tier, dict) and "provider" in kb_tier:
                kb_tier["provider"] = _normalize_kb_provider(kb_tier["provider"])

    cfg = AgentqConfig(
        project=_coerce(raw.get("project"), Project),
        agent=_coerce(raw.get("agent"), Agent),
        deployment=_coerce(raw.get("deployment"), Deployment),
        runtime=_coerce(runtime_raw, Runtime),
        knowledge_base=_coerce(kb_raw, KnowledgeBase),
        observability=_coerce(raw.get("observability"), Observability),
        hooks=_coerce(raw.get("hooks"), Hooks),
        project_root=p.parent,
        gitops=gitops_parsed,
        tiers=tiers_parsed,
    )

    # Always inject MODEL and the VertexAI flag if absent.
    cfg.runtime.env_vars.setdefault("MODEL", cfg.runtime.model)
    cfg.runtime.env_vars.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    # Inject KB_DATASTORE from legacy or — for GitOps projects — from the
    # default tier. Tier-specific deploys will override this in deploy.py
    # via the resolved target.
    if cfg.knowledge_base.provider == "gemini-enterprise-search" and cfg.datastore_resource:
        cfg.runtime.env_vars.setdefault("KB_DATASTORE", cfg.datastore_resource)
    elif cfg.gitops and cfg.gitops.enabled:
        default_target = cfg.resolve_target(None)  # uses gitops.default_tier
        if default_target.datastore_resource:
            cfg.runtime.env_vars.setdefault("KB_DATASTORE", default_target.datastore_resource)

    # extra_packages is always extended with the project's main package
    # at deploy time (see agentq_runtime/deploy.py::_normalize_extra_packages).

    return cfg


def update_resource_name(
    config_file: str | os.PathLike[str], resource_name: Optional[str],
) -> None:
    """Persist (or clear) the deployment.resource_name field.

    Passing ``None`` writes ``resource_name: null`` — this is how
    `agentq destroy` undoes a previous deploy persistence so the next
    `agentq deploy` defaults back to a fresh create instead of trying to
    update a resource that no longer exists.

    NOTE: this is the LEGACY single-tier persistence path. For GitOps
    projects, state persistence happens in GCS (see agentq_runtime/state.py),
    not in agentq.config.yaml.
    """
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
