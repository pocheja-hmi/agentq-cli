"""Central deploy script — invoked by `agentq deploy`.

Reads agentq.config.yaml, builds the AdkApp, runs optional hooks, and calls
agent_engines.create() or .update(). After a successful create, the new
resource_name is written back into agentq.config.yaml so subsequent invocations
default to update mode.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from agentq_runtime import config as cfgmod
from agentq_runtime import hooks as hookmod


# Packages the Agent Engine SDK requires inside the deployed container.
# Keep in sync with src/lib/runtime-packages.ts (BASE) on the Node side.
# We defensively ensure they're present at deploy time so projects scaffolded
# with older agentq-cli versions don't have to edit agentq.config.yaml.
_REQUIRED_PACKAGES: dict[str, str] = {
    "google-cloud-aiplatform": "google-cloud-aiplatform[adk]>=1.95.0",
    "google-adk":              "google-adk>=1.27.0",
    "google-genai":            "google-genai>=1.0.0",
    "cloudpickle":             "cloudpickle>=3.0.0",
    "pydantic":                "pydantic>=2.5.0",
}


def _package_root(pin: str) -> str:
    """Strip extras / version specifiers / whitespace from a pip requirement."""
    head = pin.split(";", 1)[0]              # drop env markers
    head = head.split("[", 1)[0]             # drop extras
    for sep in (">=", "==", "<=", "<", ">", "~=", "!="):
        head = head.split(sep, 1)[0]
    return head.strip().lower()


def _ensure_required_packages(packages: list[str]) -> list[str]:
    """Return packages with any missing-but-required entries appended.

    User customisations (custom pins, extra deps) are preserved verbatim;
    we only ADD missing required ones.
    """
    out = list(packages)
    seen = {_package_root(p) for p in packages}
    for key, default_pin in _REQUIRED_PACKAGES.items():
        if key.lower() not in seen:
            out.append(default_pin)
    return out


def _init_vertex(cfg, target=None) -> None:
    """Initialize Vertex SDK before calling agent_engines.create()/.update().

    In tier mode (target supplied) the project/location/staging_bucket come
    from the resolved target so each tier deploys into its own GCP project
    + bucket. Falls back to the legacy `cfg.deployment.*` block otherwise.

    agent_engines.create() requires `staging_bucket` in vertexai.init() —
    not in the create kwargs — so this must run before every create/update.
    """
    # Re-run compat shim in case anything cleared/replaced the Logger class.
    from agentq_runtime import _sdk_compat
    _sdk_compat.install()
    import vertexai
    if target is not None:
        project = target.gcp_project
        location = target.location
        staging_bucket = target.staging_bucket
    else:
        project = cfg.deployment.gcp_project
        location = cfg.deployment.location
        staging_bucket = cfg.deployment.staging_bucket
    vertexai.init(
        project=project,
        location=location,
        staging_bucket=staging_bucket,
    )


def _build_app(cfg):
    from vertexai.agent_engines import AdkApp
    root_agent = cfgmod.import_root_agent(cfg)
    return AdkApp(agent=root_agent, enable_tracing=cfg.observability.tracing)


def _layout_root(cfg) -> Path:
    """The directory we chdir into before calling agent_engines.create().

    The Gemini Enterprise SDK tars `extra_packages` paths relative to cwd. Whatever
    ends up at the tarball root is what `import <pkg>` can find inside the
    container. AgentQ's standard layout is:

        <project_root>/src/<package>/...

    so the right cwd is `<project_root>/src/`, which makes `<package>` the
    bare name to ship. Falls back to `<project_root>/<package>` for
    unconventional layouts (no src/ folder).
    """
    src_dir = cfg.project_root / "src"
    if (src_dir / cfg.project.package).is_dir():
        return src_dir
    if (cfg.project_root / cfg.project.package).is_dir():
        return cfg.project_root
    raise FileNotFoundError(
        f"Cannot find package '{cfg.project.package}' under "
        f"{src_dir} or {cfg.project_root}. Verify project.package in "
        f"agentq.config.yaml matches the directory containing agent.py."
    )


def _normalize_extra_packages(cfg) -> list[str]:
    """Build the extra_packages list passed to agent_engines.create().

    Always includes the project's main package as a bare name. User-supplied
    entries from `runtime.extra_packages` are normalised:

        - './src/<pkg>'  → '<pkg>'   (legacy form; we now chdir into src/)
        - 'src/<pkg>'    → '<pkg>'
        - './foo'        → 'foo'
        - 'foo'          → 'foo'
        - '/abs/path'    → kept absolute (caller knows what they're doing)

    Duplicates of the main package are dropped.
    """
    main = cfg.project.package
    out: list[str] = [main]
    seen: set[str] = {main}
    for p in (cfg.runtime.extra_packages or []):
        s = p.strip()
        if not s:
            continue
        if not os.path.isabs(s):
            if s.startswith("./"):
                s = s[2:]
            if s.startswith("src/"):
                s = s[4:]
        # Skip duplicates by bare name (handles users who explicitly listed
        # the main package, with or without legacy './src/' prefix).
        key = os.path.basename(s.rstrip("/")) if not os.path.isabs(s) else s
        if key in seen:
            continue
        out.append(s)
        seen.add(key)
    return out


def _filter_unsupported_kwargs(callable_or_method, kwargs: dict) -> dict:
    """Drop kwargs the callable doesn't accept, with a warning.

    `agent_engines.create()` / `.update()` accept different keyword sets
    across google-cloud-aiplatform versions (e.g. `labels` was added then
    removed between 1.x minor versions). Rather than pinning the SDK to a
    narrow range, we discover what the installed version actually accepts
    via `inspect.signature` and silently drop the rest. Worst case the user
    loses a non-critical metadata feature; best case the deploy still works.
    """
    import inspect
    try:
        sig = inspect.signature(callable_or_method)
    except (TypeError, ValueError):
        return kwargs  # signature inspection failed; pass through
    accepted = set(sig.parameters.keys())
    accepts_var_kw = any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
    )
    if accepts_var_kw:
        return kwargs
    dropped = [k for k in kwargs if k not in accepted]
    if dropped:
        print(f"  [deploy] note: dropping kwargs unsupported by installed SDK: {dropped}")
    return {k: v for k, v in kwargs.items() if k in accepted}


def _common_kwargs(cfg, target=None) -> dict:
    """Build the kwargs dict that goes to agent_engines.create/update.

    When `target` is supplied (tier mode), labels and the engine-runtime SA
    come from the resolved target instead of the legacy deployment block.
    Auto-injected env vars (KB_DATASTORE, MODEL) are also re-evaluated
    against the target's tier so the deployed container points at the right
    datastore.
    """
    requirements = _ensure_required_packages(cfg.runtime.python_packages)
    added = set(requirements) - set(cfg.runtime.python_packages)
    if added:
        print(f"  [deploy] auto-adding required runtime packages: {sorted(added)}")

    env_vars = dict(cfg.runtime.env_vars)
    if target is not None and target.datastore_resource:
        # Override KB_DATASTORE for the specific tier we're deploying to —
        # avoids the wrong tier's datastore leaking in from cfg.runtime.env_vars
        # (which was populated from the default tier or legacy block at load).
        env_vars["KB_DATASTORE"] = target.datastore_resource
    if target is not None and target.env_vars:
        # Per-tier env var overrides win over the global runtime.env_vars —
        # e.g. a tier in a different GCP project pointing at its own Cloud SQL
        # instance, DB user, and Secret Manager refs.
        env_vars.update(target.env_vars)

    # Vertex rejects env vars with empty-string values
    # ("reasoning_engine.spec.deployment_spec.env[N].value: Required field
    # is not set"). Strip them so users can leave commented-out placeholder
    # keys in agentq.config.yaml without breaking deploys.
    empty_keys = sorted(k for k, v in env_vars.items() if v == "" or v is None)
    if empty_keys:
        print(f"  [deploy] note: dropping empty env_vars: {empty_keys}")
        env_vars = {k: v for k, v in env_vars.items() if k not in empty_keys}

    kwargs = dict(
        agent_engine=_build_app(cfg),
        requirements=requirements,
        extra_packages=_normalize_extra_packages(cfg),
        env_vars=env_vars,
    )
    if target is not None and target.labels:
        kwargs["labels"] = target.labels
    return kwargs


def _with_layout_cwd(cfg, fn):
    """Run fn() from the layout root so SDK tar paths resolve correctly."""
    layout = _layout_root(cfg)
    saved = os.getcwd()
    os.chdir(layout)
    try:
        return fn()
    finally:
        os.chdir(saved)


def cmd_create_for_target(cfg, target) -> str:
    """Create an engine for an arbitrary resolved target.

    Used by:
      - cmd_create() in legacy mode (target = cfg.resolve_target(None)).
      - state.cmd_apply() in tier mode after a `plan` says mode=create.

    Single place that knows how to build a Reasoning Engine — keeps the
    create logic from forking between deploy.py and state.py.
    """
    _init_vertex(cfg, target=target)
    from vertexai import agent_engines
    print(f"  [deploy] creating Reasoning Engine for {target.display_name}")

    def _do() -> str:
        kwargs = _common_kwargs(cfg, target)
        kwargs["display_name"] = target.display_name
        kwargs["description"] = cfg.project.description or target.display_name
        if target.runtime_service_account:
            kwargs["service_account"] = target.runtime_service_account
        remote = agent_engines.create(**_filter_unsupported_kwargs(agent_engines.create, kwargs))
        print(f"  [deploy] ✓ created: {remote.resource_name}")
        return remote.resource_name

    return _with_layout_cwd(cfg, _do)


def cmd_create(cfg) -> str:
    """Legacy entry point — resolves to default target and calls the
    target-aware version."""
    target = cfg.resolve_target(None)
    return cmd_create_for_target(cfg, target)


class ResourceMissing(RuntimeError):
    """Raised when the persisted resource_name doesn't exist on the server.

    main() catches this and translates it into a distinct exit code so the
    Node layer can render an actionable hint about --recreate instead of
    dumping the SDK traceback.
    """


def cmd_update_for_target(cfg, target, resource_name: str) -> str:
    """Update an engine for an arbitrary resolved target. See
    cmd_create_for_target() for the rationale on the for_target split."""
    _init_vertex(cfg, target=target)
    from vertexai import agent_engines
    print(f"  [deploy] updating {resource_name}")

    def _do() -> str:
        try:
            # Cheap existence check before the heavy build/serialize step.
            remote = agent_engines.get(resource_name)
        except Exception as e:
            msg = str(e)
            if "not found" in msg.lower() or "NotFound" in type(e).__name__:
                raise ResourceMissing(resource_name) from e
            raise

        kwargs = _common_kwargs(cfg, target)
        if target.runtime_service_account:
            kwargs["service_account"] = target.runtime_service_account
        remote.update(**_filter_unsupported_kwargs(remote.update, kwargs))
        print(f"  [deploy] ✓ updated: {resource_name}")
        return resource_name

    return _with_layout_cwd(cfg, _do)


def cmd_update(cfg, resource_name: str) -> str:
    """Legacy entry point. Resolves to default target then delegates."""
    target = cfg.resolve_target(None)
    return cmd_update_for_target(cfg, target, resource_name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config_file")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--create", action="store_true")
    grp.add_argument("--update", action="store_true")
    parser.add_argument("--resource-name", default=None)
    args = parser.parse_args()

    cfg = cfgmod.load(args.config_file)
    cwd_to_root = os.getcwd()
    os.chdir(cfg.project_root)
    try:
        _init_vertex(cfg)

        # Pre-deploy hook (optional).
        pre = hookmod.load_hook(cfg.project_root, cfg.hooks.pre_deploy)
        if pre:
            print(f"  [deploy] running pre_deploy hook: {cfg.hooks.pre_deploy}")
            pre({"config": cfg, "phase": "pre"})

        if args.create:
            new_name = cmd_create(cfg)
            cfgmod.update_resource_name(args.config_file, new_name)
            resource_name = new_name
        else:
            resource_name = args.resource_name or cfg.deployment.resource_name
            if not resource_name:
                print(
                    "ERROR: --update requested but no resource_name in config or flags.",
                    file=sys.stderr,
                )
                return 2
            try:
                cmd_update(cfg, resource_name)
            except ResourceMissing as e:
                # Distinct exit code 3 — the Node layer renders an actionable
                # hint about --recreate. Avoids printing the SDK traceback
                # which would otherwise dominate the user's terminal.
                print(
                    f"ERROR: Reasoning Engine {e} no longer exists. "
                    "It was likely deleted in the Cloud console.",
                    file=sys.stderr,
                )
                return 3

        # Post-deploy hook (optional).
        post = hookmod.load_hook(cfg.project_root, cfg.hooks.post_deploy)
        if post:
            print(f"  [deploy] running post_deploy hook: {cfg.hooks.post_deploy}")
            post({"config": cfg, "phase": "post", "resource_name": resource_name})

        return 0
    finally:
        os.chdir(cwd_to_root)


if __name__ == "__main__":
    sys.exit(main())
