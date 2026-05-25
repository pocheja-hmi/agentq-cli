"""Delete a Reasoning Engine + post-destroy cleanup.

Behaviour matches `agentq destroy` documented in src/commands/destroy.ts:

    default            : delete engine, clear matching resource_name from
                         agentq.config.yaml.
    --purge            : also delete gs://<staging>/agent_engine/* artifacts.

Confirmation is owned by the Node layer; this script never prompts.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Installs SDK compat shim before vertexai imports.
from agentq_runtime import _sdk_compat  # noqa: F401
from agentq_runtime import config as cfgmod


def _parse_loc(resource_name: str) -> tuple[str, str]:
    m = re.match(r"projects/([^/]+)/locations/([^/]+)/reasoningEngines/[\w-]+", resource_name)
    if not m:
        raise SystemExit(f"Invalid resource_name: {resource_name}")
    return m.group(1), m.group(2)


def _delete_engine(resource_name: str) -> None:
    """Delete a Reasoning Engine and any child resources (sessions, etc.).

    force=True is the right default for `agentq destroy` because sessions
    are scoped to their parent engine — they're meaningless once the engine
    is gone, and the SDK otherwise refuses the delete with FailedPrecondition.
    """
    project, location = _parse_loc(resource_name)
    import vertexai
    from vertexai import agent_engines
    vertexai.init(project=project, location=location)
    agent_engines.delete(resource_name, force=True)


def _clear_config_resource_name(config_file: Path, resource_name: str) -> bool:
    """If config_file's deployment.resource_name matches, clear it.

    Returns True if the file was actually modified.
    """
    if not config_file.is_file():
        return False
    cfg = cfgmod.load(config_file)
    if cfg.deployment.resource_name != resource_name:
        return False
    cfgmod.update_resource_name(config_file, None)
    return True


def _purge_staging(staging_bucket: str) -> int:
    """Delete every object under gs://<bucket>/agent_engine/*.

    Returns the number of blobs removed. Failures are reported but do not
    raise — the engine is already gone; partial cleanup is acceptable.
    """
    if staging_bucket.startswith("gs://"):
        bucket_name = staging_bucket[5:].rstrip("/")
    else:
        bucket_name = staging_bucket.rstrip("/")
    try:
        from google.cloud import storage
        from google.cloud.exceptions import NotFound
    except Exception as e:
        print(f"WARN: google-cloud-storage not importable: {e}", file=sys.stderr)
        return 0

    client = storage.Client()
    try:
        bucket = client.get_bucket(bucket_name)
    except NotFound:
        print(f"WARN: staging bucket gs://{bucket_name} not found.", file=sys.stderr)
        return 0

    deleted = 0
    for blob in bucket.list_blobs(prefix="agent_engine/"):
        try:
            blob.delete()
            deleted += 1
        except Exception as e:
            print(f"WARN: could not delete gs://{bucket_name}/{blob.name}: {e}", file=sys.stderr)
    return deleted


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("resource_name")
    parser.add_argument("--purge", action="store_true",
                        help="Also delete staging artifacts under "
                             "gs://<staging_bucket>/agent_engine/.")
    parser.add_argument("--config-file", default=None,
                        help="Path to agentq.config.yaml. If provided and its "
                             "resource_name matches, that field is cleared.")
    parser.add_argument("--tier", default=None,
                        help="Tier the resource belongs to (dev/staging/prod). "
                             "When set, --config-file's tier's staging bucket "
                             "is used for purge; legacy resource_name clearing "
                             "is skipped (state file cleanup is Node-side).")
    args = parser.parse_args()

    # 1. Delete the Reasoning Engine itself.
    _delete_engine(args.resource_name)
    print(f"  [destroy] ✓ deleted {args.resource_name}")

    # 2. In legacy mode, clear matching resource_name from config. In tier
    #    mode, this is a no-op (Node deletes the state.yaml in GCS instead).
    if args.config_file and not args.tier:
        cfg_path = Path(args.config_file)
        if _clear_config_resource_name(cfg_path, args.resource_name):
            print(f"  [destroy] ✓ cleared resource_name from {cfg_path.name}")

    # 3. Optionally purge staging artifacts. In tier mode, use the tier's
    #    staging bucket (not the legacy one).
    if args.purge and args.config_file:
        cfg = cfgmod.load(args.config_file)
        target = cfg.resolve_target(args.tier)
        staging_bucket = target.staging_bucket or cfg.deployment.staging_bucket
        n = _purge_staging(staging_bucket)
        print(f"  [destroy] ✓ purged {n} staging artifact(s) from "
              f"{staging_bucket}/agent_engine/")

    return 0


if __name__ == "__main__":
    sys.exit(main())
