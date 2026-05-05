"""List Reasoning Engines in a GCP project/location."""
from __future__ import annotations

import argparse
import json
import sys

# Importing the package installs the SDK compat shim before vertexai is touched.
from agentq_runtime import _sdk_compat  # noqa: F401


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gcp-project", required=True)
    parser.add_argument("--location", default="us-central1")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    import vertexai
    from vertexai import agent_engines
    vertexai.init(project=args.gcp_project, location=args.location)

    items = list(agent_engines.list())
    if args.json:
        print(json.dumps(
            [{"resource_name": d.resource_name, "display_name": d.display_name} for d in items],
            indent=2,
        ))
        return 0

    if not items:
        print("(no deployments found.)")
        return 0
    for d in items:
        print(f"- {d.resource_name}")
        print(f"    display_name: {d.display_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
