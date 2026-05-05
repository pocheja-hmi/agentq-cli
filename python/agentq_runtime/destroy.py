"""Delete a Reasoning Engine. Confirmation is handled by the Node CLI."""
from __future__ import annotations

import argparse
import re
import sys

# Installs SDK compat shim before vertexai imports.
from agentq_runtime import _sdk_compat  # noqa: F401


def _parse_loc(resource_name: str) -> tuple[str, str]:
    m = re.match(r"projects/([^/]+)/locations/([^/]+)/reasoningEngines/[\w-]+", resource_name)
    if not m:
        raise SystemExit(f"Invalid resource_name: {resource_name}")
    return m.group(1), m.group(2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("resource_name")
    args = parser.parse_args()

    project, location = _parse_loc(args.resource_name)

    import vertexai
    from vertexai import agent_engines
    vertexai.init(project=project, location=location)
    agent_engines.delete(args.resource_name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
