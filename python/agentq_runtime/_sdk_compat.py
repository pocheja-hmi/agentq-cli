"""Compatibility shims for the Gemini Enterprise Python SDK.

This module patches known SDK bugs that block AgentQ deployments. It is
imported at the very top of every CLI entry point (deploy / list / destroy)
so the patches are in place before any `vertexai.*` import.

Each patch:
- Targets a single, named upstream bug.
- Is self-disabling: if the underlying SDK already provides the missing API,
  the patch becomes a no-op.
- Fails closed — silently skips itself if the SDK module shape changes,
  rather than crashing the CLI.

Patches:
    LOGGER_LOG_CREATE_WITH_LRO
        vertexai.agent_engines._agent_engines.create() calls
        _LOGGER.log_create_with_lro(cls, lro). The method is missing on
        google.cloud.aiplatform.base.Logger in current SDK builds, so the
        deploy crashes RIGHT AFTER the LRO has been kicked off. Restoring
        the method lets the create call wait on the LRO normally and
        return the new resource_name.
"""
from __future__ import annotations

import logging

_log = logging.getLogger("agentq.sdk_compat")


def _make_log_create_with_lro():
    """Return a closure suitable as a Logger.log_create_with_lro method."""
    def log_create_with_lro(self, cls, lro):  # type: ignore[no-untyped-def]
        try:
            cls_name = getattr(cls, "__name__", str(cls))
            op = getattr(lro, "operation", None)
            op_name = getattr(op, "name", "<unknown>")
            self.info(
                f"Creating {cls_name} resource. "
                f"Long-running operation: {op_name}. "
                "(method log_create_with_lro provided by agentq-cli compat shim.)"
            )
        except Exception:
            # Logging must never break the call.
            pass
    return log_create_with_lro


def _patch_logger_log_create_with_lro() -> None:
    """Restore the missing log_create_with_lro method.

    Why this is harder than it looks:

    `aiplatform.base.Logger` is a FACTORY that calls
    `logging.setLoggerClass(VertexLogger)` followed by
    `logging.getLogger(name)`. Python's logging module caches loggers by
    name globally. If ANY code path calls `logging.getLogger("vertexai...")`
    before that factory runs (and they do), the cache locks in a plain
    `logging.Logger` and the factory returns it unchanged on every later
    call — VertexLogger is never substituted in.

    So we must patch in three places:
      1. `aiplatform.base.VertexLogger` — covers correctly-cached instances.
      2. `logging.Logger` — covers the stdlib instances that won the cache
         race. Adding a single method to logging.Logger is harmless because
         we only add a NEW name; we never overwrite an existing one.
      3. The known live instances — `vertexai.agent_engines._utils.LOGGER`
         and `_agent_engines._LOGGER` — bound on the instance directly as
         a final belt-and-suspenders.
    """
    method = _make_log_create_with_lro()
    patched: list[str] = []

    # 1. Class-level patches.
    for module_path, class_name in (
        ("google.cloud.aiplatform.base", "VertexLogger"),
        ("logging", "Logger"),
    ):
        try:
            mod = __import__(module_path, fromlist=[class_name])
            cls = getattr(mod, class_name, None)
            if cls is None or not isinstance(cls, type):
                continue
            if hasattr(cls, "log_create_with_lro"):
                continue
            cls.log_create_with_lro = method
            patched.append(f"{module_path}.{class_name}")
        except Exception as e:
            _log.debug("class patch on %s.%s skipped: %s", module_path, class_name, e)

    # 2. Bind on known live instances. These imports may not yet be loaded —
    #    skip silently if so. A second invocation of install() (e.g. from
    #    deploy._init_vertex) will catch them once they exist.
    for module_path, attr_name in (
        ("vertexai.agent_engines._utils",          "LOGGER"),
        ("vertexai.agent_engines._agent_engines", "_LOGGER"),
    ):
        try:
            mod = __import__(module_path, fromlist=[attr_name])
            inst = getattr(mod, attr_name, None)
            if inst is None:
                continue
            if hasattr(inst, "log_create_with_lro") and not isinstance(
                getattr(type(inst), "log_create_with_lro", None), type(method)
            ):
                # Already provided by class-level patch — fine.
                continue
            try:
                # types.MethodType binds an unbound function to an instance.
                from types import MethodType
                inst.log_create_with_lro = MethodType(method, inst)
                patched.append(f"{module_path}.{attr_name}")
            except (AttributeError, TypeError):
                # Some logger types disallow setattr — class patch above
                # is the fallback.
                pass
        except Exception as e:
            _log.debug("instance patch on %s.%s skipped: %s", module_path, attr_name, e)

    if patched:
        _log.debug("Patched log_create_with_lro on: %s", ", ".join(patched))


def install() -> None:
    _patch_logger_log_create_with_lro()


# Run on import.
install()
