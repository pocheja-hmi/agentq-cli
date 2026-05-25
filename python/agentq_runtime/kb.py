"""Knowledge-base provisioning for the Gemini Enterprise Search provider.

Subcommands match the KBProvider contract on the Node side:
    create-bucket | upload | create-datastore | import |
    list | delete-doc <id> | purge | delete-datastore

Tier-awareness:
  - Every helper takes a `target` (ResolvedTarget from config.AgentqConfig.
    resolve_target). The target carries the per-tier datastore + bucket +
    GCP project.
  - The cmd_* functions resolve the target from --tier and then dispatch.
  - state.cmd_apply() bypasses argparse by calling cmd_apply_for_target()
    directly with the already-resolved target + plan dict.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from agentq_runtime import config as cfgmod


# ─── Target-aware primitives ─────────────────────────────────────────────────

def _bucket_name_for(target) -> str:
    name = target.kb.bucket
    if not name:
        raise SystemExit("kb.bucket is not set for this target.")
    return name[5:] if name.startswith("gs://") else name


def _datastore_clients_for(target):
    from google.cloud import discoveryengine_v1 as de
    location = target.kb.location
    options = {"api_endpoint": f"{location}-discoveryengine.googleapis.com"} if location != "global" else {}
    return de, de.DataStoreServiceClient(client_options=options), de.DocumentServiceClient(client_options=options)


def _datastore_path_for(target) -> str:
    if not target.datastore_resource:
        raise SystemExit("kb.datastore_id is not set for this target.")
    return target.datastore_resource


def _branch_for(target) -> str:
    return f"{_datastore_path_for(target)}/branches/default_branch"


# ─── Target-aware command handlers ───────────────────────────────────────────

def cmd_create_bucket_for_target(cfg, target) -> int:
    from google.cloud import storage
    name = _bucket_name_for(target)
    client = storage.Client(project=target.gcp_project)
    if client.lookup_bucket(name) is not None:
        print(f"Bucket gs://{name} already exists.")
        return 0
    bucket = client.create_bucket(name, location=target.location)
    print(f"✓ Created gs://{bucket.name}")
    return 0


def cmd_upload_for_target(cfg, target) -> int:
    from google.cloud import storage
    docs_dir = cfg.project_root / "knowledge"
    if not docs_dir.is_dir():
        print(f"No knowledge/ folder at {docs_dir}. Drop your documents in there first.", file=sys.stderr)
        return 1
    client = storage.Client(project=target.gcp_project)
    bucket = client.bucket(_bucket_name_for(target))
    files = sorted(p for p in docs_dir.rglob("*") if p.is_file())
    if not files:
        print(f"No files in {docs_dir}.", file=sys.stderr)
        return 1
    for path in files:
        rel = path.relative_to(cfg.project_root)
        blob = bucket.blob(str(rel))
        blob.upload_from_filename(str(path))
        print(f"  ↑ gs://{bucket.name}/{rel}")
    print(f"✓ Uploaded {len(files)} file(s)")
    return 0


def cmd_create_datastore_for_target(cfg, target) -> int:
    de, ds_client, _ = _datastore_clients_for(target)
    parent = (
        f"projects/{target.gcp_project}"
        f"/locations/{target.kb.location}"
        f"/collections/default_collection"
    )
    try:
        existing = ds_client.get_data_store(name=_datastore_path_for(target))
        print(f"Datastore already exists: {existing.name}")
        return 0
    except Exception:
        pass
    op = ds_client.create_data_store(
        parent=parent,
        data_store_id=target.kb.datastore_id,
        data_store=de.DataStore(
            display_name=target.kb.datastore_id,
            industry_vertical=de.IndustryVertical.GENERIC,
            solution_types=[de.SolutionType.SOLUTION_TYPE_SEARCH],
            content_config=de.DataStore.ContentConfig.CONTENT_REQUIRED,
        ),
    )
    print("Creating datastore — this takes ~30 seconds…")
    op.result(timeout=300)
    print(f"✓ Created datastore: {_datastore_path_for(target)}")
    return 0


def cmd_import_for_target(cfg, target) -> int:
    de, _, doc_client = _datastore_clients_for(target)
    op = doc_client.import_documents(
        request=de.ImportDocumentsRequest(
            parent=_branch_for(target),
            gcs_source=de.GcsSource(
                input_uris=[f"gs://{_bucket_name_for(target)}/*"],
                data_schema="content",
            ),
            reconciliation_mode=de.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
        )
    )
    print("Importing — indexing runs asynchronously after this returns…")
    op.result(timeout=900)
    print("✓ Import job complete. Allow 1–5 minutes for indexing to finish.")
    return 0


def cmd_list_for_target(cfg, target) -> int:
    _, _, doc_client = _datastore_clients_for(target)
    docs = list(doc_client.list_documents(parent=_branch_for(target)))
    if not docs:
        print("(no documents)")
        return 0
    for d in docs:
        doc_id = d.name.rsplit("/", 1)[-1]
        uri = d.content.uri if d.content and d.content.uri else "(no uri)"
        print(f"- {doc_id}  ←  {uri}")
    return 0


def cmd_delete_doc_for_target(cfg, target, doc_id: str) -> int:
    _, _, doc_client = _datastore_clients_for(target)
    doc_client.delete_document(name=f"{_branch_for(target)}/documents/{doc_id}")
    print(f"✓ Deleted document: {doc_id}")
    return 0


def cmd_purge_for_target(cfg, target) -> int:
    de, _, doc_client = _datastore_clients_for(target)
    op = doc_client.purge_documents(
        request=de.PurgeDocumentsRequest(parent=_branch_for(target), filter="*", force=True)
    )
    op.result(timeout=600)
    print("✓ Purged all documents from datastore.")
    return 0


def cmd_delete_datastore_for_target(cfg, target) -> int:
    _, ds_client, _ = _datastore_clients_for(target)
    op = ds_client.delete_data_store(name=_datastore_path_for(target))
    op.result(timeout=300)
    print(f"✓ Deleted datastore: {target.kb.datastore_id}")
    return 0


def cmd_apply_for_target(cfg, target, kb_plan: dict[str, Any]) -> int:
    """Drive a KB reimport according to a plan dict.

    Called by state.cmd_apply when plan.kb_plan.action == 'reimport'. The
    sequence is intentionally conservative:
      1. Upload added + changed local files to GCS.
      2. Delete removed documents from the datastore.
      3. Run an INCREMENTAL import so the datastore re-indexes the updated
         GCS objects.

    Existing unchanged docs are left untouched. document_ids for newly-added
    files are resolved by the next `state.diff` / `state import --with-kb`.
    """
    from google.cloud import storage as _storage

    docs = kb_plan.get("documents", {}) or {}
    added   = docs.get("added", []) or []
    changed = docs.get("changed", []) or []
    removed = docs.get("removed", []) or []

    if not (added or changed or removed):
        print("  [kb] nothing to do — added/changed/removed all empty.")
        return 0

    # 1. Upload added + changed
    if added or changed:
        client = _storage.Client(project=target.gcp_project)
        bucket = client.bucket(_bucket_name_for(target))
        for d in added + changed:
            local = cfg.project_root / d["filename"]
            if not local.is_file():
                print(f"  [kb] WARN: {local} no longer exists; skipping upload.", file=sys.stderr)
                continue
            blob = bucket.blob(d["filename"])
            blob.upload_from_filename(str(local))
            print(f"  [kb] ↑ uploaded {d['filename']}")

    # 2. Delete removed
    if removed:
        _, _, doc_client = _datastore_clients_for(target)
        for d in removed:
            doc_id = d.get("document_id")
            if not doc_id:
                print(f"  [kb] WARN: {d['filename']} has no document_id in state; skipping delete.", file=sys.stderr)
                continue
            try:
                doc_client.delete_document(name=f"{_branch_for(target)}/documents/{doc_id}")
                print(f"  [kb] - removed {d['filename']} (doc {doc_id})")
            except Exception as e:
                print(f"  [kb] WARN: failed to delete {doc_id}: {e}", file=sys.stderr)

    # 3. Trigger incremental reimport so Gemini Enterprise Search picks up the new
    #    objects. INCREMENTAL mode replaces existing entries by URI.
    if added or changed:
        cmd_import_for_target(cfg, target)
    return 0


# ─── Legacy wrappers (no tier) ───────────────────────────────────────────────
# Existing call sites kept working by resolving the default target.

def cmd_create_bucket(cfg) -> int:
    return cmd_create_bucket_for_target(cfg, cfg.resolve_target(None))

def cmd_upload(cfg) -> int:
    return cmd_upload_for_target(cfg, cfg.resolve_target(None))

def cmd_create_datastore(cfg) -> int:
    return cmd_create_datastore_for_target(cfg, cfg.resolve_target(None))

def cmd_import(cfg) -> int:
    return cmd_import_for_target(cfg, cfg.resolve_target(None))

def cmd_list(cfg) -> int:
    return cmd_list_for_target(cfg, cfg.resolve_target(None))

def cmd_delete_doc(cfg, doc_id: str) -> int:
    return cmd_delete_doc_for_target(cfg, cfg.resolve_target(None), doc_id)

def cmd_purge(cfg) -> int:
    return cmd_purge_for_target(cfg, cfg.resolve_target(None))

def cmd_delete_datastore(cfg) -> int:
    return cmd_delete_datastore_for_target(cfg, cfg.resolve_target(None))


# ─── argparse main ───────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("subcommand")
    parser.add_argument("config_file")
    parser.add_argument("rest", nargs="*")
    parser.add_argument("--tier", default=None, help="Operate on a specific tier (dev/staging/prod).")
    args = parser.parse_args()

    cfg = cfgmod.load(args.config_file)
    target = cfg.resolve_target(args.tier)

    sub = args.subcommand
    handlers = {
        "create-bucket":     lambda: cmd_create_bucket_for_target(cfg, target),
        "upload":            lambda: cmd_upload_for_target(cfg, target),
        "create-datastore":  lambda: cmd_create_datastore_for_target(cfg, target),
        "import":            lambda: cmd_import_for_target(cfg, target),
        "list":              lambda: cmd_list_for_target(cfg, target),
        "delete-doc":        lambda: cmd_delete_doc_for_target(cfg, target, args.rest[0]) if args.rest else _die("delete-doc requires <id>"),
        "purge":             lambda: cmd_purge_for_target(cfg, target),
        "delete-datastore":  lambda: cmd_delete_datastore_for_target(cfg, target),
    }
    fn = handlers.get(sub)
    if fn is None:
        print(f"Unknown subcommand: {sub}", file=sys.stderr)
        return 2
    return int(fn() or 0)


def _die(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
