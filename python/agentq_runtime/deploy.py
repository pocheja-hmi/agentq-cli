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


def _init_vertex(cfg) -> None:
    # Re-run compat shim in case anything cleared/replaced the Logger class.
    from agentq_runtime import _sdk_compat
    _sdk_compat.install()
    import vertexai
    vertexai.init(
        project=cfg.deployment.gcp_project,
        location=cfg.deployment.location,
        staging_bucket=cfg.deployment.staging_bucket,
    )


def _build_app(cfg):
    from vertexai.agent_engines import AdkApp
    root_agent = cfgmod.import_root_agent(cfg)
    return AdkApp(agent=root_agent, enable_tracing=cfg.observability.tracing)


def _layout_root(cfg) -> Path:
    """The directory we chdir into before calling agent_engines.create().

    The Vertex AI SDK tars `extra_packages` paths relative to cwd. Whatever
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


def _common_kwargs(cfg) -> dict:
    requirements = _ensure_required_packages(cfg.runtime.python_packages)
    added = set(requirements) - set(cfg.runtime.python_packages)
    if added:
        print(f"  [deploy] auto-adding required runtime packages: {sorted(added)}")
    return dict(
        agent_engine=_build_app(cfg),
        requirements=requirements,
        extra_packages=_normalize_extra_packages(cfg),
        env_vars=cfg.runtime.env_vars,
    )


def _with_layout_cwd(cfg, fn):
    """Run fn() from the layout root so SDK tar paths resolve correctly."""
    layout = _layout_root(cfg)
    saved = os.getcwd()
    os.chdir(layout)
    try:
        return fn()
    finally:
        os.chdir(saved)


def cmd_create(cfg) -> str:
    from vertexai import agent_engines
    print(f"  [deploy] creating Reasoning Engine for {cfg.project.display_name}")

    def _do() -> str:
        kwargs = _common_kwargs(cfg)
        kwargs["display_name"] = cfg.project.display_name
        kwargs["description"] = cfg.project.description or cfg.project.display_name
        if cfg.deployment.service_account:
            kwargs["service_account"] = cfg.deployment.service_account
        remote = agent_engines.create(**kwargs)
        print(f"  [deploy] ✓ created: {remote.resource_name}")
        return remote.resource_name

    return _with_layout_cwd(cfg, _do)


def cmd_update(cfg, resource_name: str) -> str:
    from vertexai import agent_engines
    print(f"  [deploy] updating {resource_name}")

    def _do() -> str:
        remote = agent_engines.get(resource_name)
        kwargs = _common_kwargs(cfg)
        if cfg.deployment.service_account:
            kwargs["service_account"] = cfg.deployment.service_account
        remote.update(**kwargs)
        print(f"  [deploy] ✓ updated: {resource_name}")
        return resource_name

    return _with_layout_cwd(cfg, _do)


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
            cmd_update(cfg, resource_name)

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
