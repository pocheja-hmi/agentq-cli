"""AgentQ Python runtime — bundled with agentq-cli.

Modules:
    config       — load and validate agentq.config.yaml
    deploy       — create / update Reasoning Engines
    destroy      — delete Reasoning Engines
    list_engines — list deployments
    kb           — manage Vertex AI Search datastores
    hooks        — load optional project deploy_hooks.py
    _silence     — suppress harmless SDK noise unless --verbose
    _sdk_compat  — monkey-patch known Vertex SDK bugs

Importing this package installs both side-effect modules. _sdk_compat MUST
run before any module here (or any user module) imports `vertexai.*`,
because some patches must land before the SDK code is loaded.
"""
from . import _sdk_compat  # noqa: F401  — must be first
from . import _silence     # noqa: F401

__version__ = "0.1.0"
