"""Suppress known-harmless warnings from the Vertex SDK.

Imported at the top of any runtime entry point. Honours AGENTQ_QUIET=1 (set
by the Node CLI when --verbose was not passed). When verbose is on this
module is a no-op so debugging stays easy.

The specific message we silence:

    Failed to register API methods. Please follow the guide to register the
    API methods: https://cloud.google.com/.../custom-methods. Error:
    {'NoneType' object has no attribute '__name__'}

It is logged by `vertexai.agent_engines` whenever it inspects an engine that
was deployed without custom method registration. Listing still returns the
correct results — the warning is purely informational.
"""
from __future__ import annotations

import logging
import os
import re
import sys
import warnings


_FILTERED_PATTERNS = [
    re.compile(r"Failed to register API methods"),
    re.compile(r"NoneType.+has no attribute.+__name__"),
]


class _Filter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(p.search(msg) for p in _FILTERED_PATTERNS)


class _StderrFilter:
    """Wraps sys.stderr so warnings printed via `print(..., file=sys.stderr)`
    are also dropped if they match. The SDK emits some messages directly,
    bypassing the logging system."""
    def __init__(self, wrapped):
        self._wrapped = wrapped

    def write(self, data: str) -> int:
        if any(p.search(data) for p in _FILTERED_PATTERNS):
            return len(data)
        return self._wrapped.write(data)

    def flush(self) -> None:
        self._wrapped.flush()

    def __getattr__(self, name):
        return getattr(self._wrapped, name)


def install() -> None:
    if not os.environ.get("AGENTQ_QUIET"):
        return
    # Logging-level filter: catches loggers under vertexai/google.cloud.
    for name in ("vertexai", "vertexai.agent_engines",
                 "google.cloud.aiplatform", "google.cloud"):
        logging.getLogger(name).addFilter(_Filter())
    # Catch direct stderr writes that bypass logging.
    sys.stderr = _StderrFilter(sys.stderr)
    # And the warnings module.
    warnings.filterwarnings("ignore", message=r".*Failed to register API methods.*")


install()
