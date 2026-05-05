"""Hook loader for the hybrid deploy model.

If a project specifies hooks.pre_deploy or hooks.post_deploy as
'scripts.deploy_hooks:pre_deploy' (importpath:callable form), this module
imports the callable. Hooks receive a single dict-like context object so
their signature is stable.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any, Callable, Optional


def _resolve(spec: str) -> Callable[..., Any]:
    if ":" not in spec:
        raise ValueError(f"Hook spec must be 'module.path:callable', got: {spec}")
    mod_path, _, func_name = spec.partition(":")
    module = importlib.import_module(mod_path)
    if not hasattr(module, func_name):
        raise AttributeError(f"{mod_path} has no attribute {func_name}")
    return getattr(module, func_name)


def load_hook(project_root: Path, spec: Optional[str]) -> Optional[Callable[..., Any]]:
    if not spec:
        return None
    sys.path.insert(0, str(project_root.resolve()))
    return _resolve(spec)
