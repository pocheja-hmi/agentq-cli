"""Knowledge-base provisioning for the Vertex AI Search provider.

Subcommands match the KBProvider contract on the Node side:
    create-bucket | upload | create-datastore | import |
    list | delete-doc <id> | purge | delete-datastore
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from agentq_runtime import config as cfgmod


def _bucket_name(cfg) -> str:
    name = cfg.knowledge_base.bucket
    if not name:
        raise SystemExit("knowledge_base.bucket is not set in agentq.config.yaml")
    # Tolerate someone passing 'gs://name' here.
    return name[5:] if name.startswith("gs://") else name


def _datastore_clients(cfg):
    from google.cloud import discoveryengine_v1 as de
    location = cfg.knowledge_base.location
    options = {"api_endpoint": f"{location}-discoveryengine.googleapis.com"} if location != "global" else {}
    return de, de.DataStoreServiceClient(client_options=options), de.DocumentServiceClient(client_options=options)


def _datastore_path(cfg) -> str:
    if not cfg.datastore_resource:
        raise SystemExit("knowledge_base.datastore_id is not set in agentq.config.yaml")
    return cfg.datastore_resource


def _branch(cfg) -> str:
    return f"{_datastore_path(cfg)}/branches/default_branch"


def cmd_create_bucket(cfg) -> int:
    from google.cloud import storage
    name = _bucket_name(cfg)
    client = storage.Client(project=cfg.deployment.gcp_project)
    if client.lookup_bucket(name) is not None:
        print(f"Bucket gs://{name} already exists.")
        return 0
    bucket = client.create_bucket(name, location=cfg.deployment.location)
    print(f"✓ Created gs://{bucket.name}")
    return 0


def cmd_upload(cfg) -> int:
    from google.cloud import storage
    docs_dir = cfg.project_root / "knowledge"
    if not docs_dir.is_dir():
        print(f"No knowledge/ folder at {docs_dir}. Drop your documents in there first.", file=sys.stderr)
        return 1
    client = storage.Client(project=cfg.deployment.gcp_project)
    bucket = client.bucket(_bucket_name(cfg))
    files = sorted(p for p in docs_dir.iterdir() if p.is_file())
    if not files:
        print(f"No files in {docs_dir}.", file=sys.stderr)
        return 1
    for path in files:
        blob = bucket.blob(path.name)
        blob.upload_from_filename(str(path))
        print(f"  ↑ gs://{bucket.name}/{path.name}")
    print(f"✓ Uploaded {len(files)} file(s)")
    return 0


def cmd_create_datastore(cfg) -> int:
    de, ds_client, _ = _datastore_clients(cfg)
    parent = (
        f"projects/{cfg.deployment.gcp_project}"
        f"/locations/{cfg.knowledge_base.location}"
        f"/collections/default_collection"
    )
    try:
        existing = ds_client.get_data_store(name=_datastore_path(cfg))
        print(f"Datastore already exists: {existing.name}")
        return 0
    except Exception:
        pass
    op = ds_client.create_data_store(
        parent=parent,
        data_store_id=cfg.knowledge_base.datastore_id,
        data_store=de.DataStore(
            display_name=cfg.knowledge_base.datastore_id,
            industry_vertical=de.IndustryVertical.GENERIC,
            solution_types=[de.SolutionType.SOLUTION_TYPE_SEARCH],
            content_config=de.DataStore.ContentConfig.CONTENT_REQUIRED,
        ),
    )
    print("Creating datastore — this takes ~30 seconds…")
    op.result(timeout=300)
    print(f"✓ Created datastore: {_datastore_path(cfg)}")
    return 0


def cmd_import(cfg) -> int:
    de, _, doc_client = _datastore_clients(cfg)
    op = doc_client.import_documents(
        request=de.ImportDocumentsRequest(
            parent=_branch(cfg),
            gcs_source=de.GcsSource(
                input_uris=[f"gs://{_bucket_name(cfg)}/*"],
                data_schema="content",
            ),
            reconciliation_mode=de.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
        )
    )
    print("Importing — indexing runs asynchronously after this returns…")
    op.result(timeout=900)
    print("✓ Import job complete. Allow 1–5 minutes for indexing to finish.")
    return 0


def cmd_list(cfg) -> int:
    _, _, doc_client = _datastore_clients(cfg)
    docs = list(doc_client.list_documents(parent=_branch(cfg)))
    if not docs:
        print("(no documents)")
        return 0
    for d in docs:
        doc_id = d.name.rsplit("/", 1)[-1]
        uri = d.content.uri if d.content and d.content.uri else "(no uri)"
        print(f"- {doc_id}  ←  {uri}")
    return 0


def cmd_delete_doc(cfg, doc_id: str) -> int:
    _, _, doc_client = _datastore_clients(cfg)
    doc_client.delete_document(name=f"{_branch(cfg)}/documents/{doc_id}")
    print(f"✓ Deleted document: {doc_id}")
    return 0


def cmd_purge(cfg) -> int:
    de, _, doc_client = _datastore_clients(cfg)
    op = doc_client.purge_documents(
        request=de.PurgeDocumentsRequest(parent=_branch(cfg), filter="*", force=True)
    )
    op.result(timeout=600)
    print("✓ Purged all documents from datastore.")
    return 0


def cmd_delete_datastore(cfg) -> int:
    _, ds_client, _ = _datastore_clients(cfg)
    op = ds_client.delete_data_store(name=_datastore_path(cfg))
    op.result(timeout=300)
    print(f"✓ Deleted datastore: {cfg.knowledge_base.datastore_id}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("subcommand")
    parser.add_argument("config_file")
    parser.add_argument("rest", nargs="*")
    args = parser.parse_args()

    cfg = cfgmod.load(args.config_file)
    sub = args.subcommand
    handlers = {
        "create-bucket":     lambda: cmd_create_bucket(cfg),
        "upload":            lambda: cmd_upload(cfg),
        "create-datastore":  lambda: cmd_create_datastore(cfg),
        "import":            lambda: cmd_import(cfg),
        "list":              lambda: cmd_list(cfg),
        "delete-doc":        lambda: cmd_delete_doc(cfg, args.rest[0]) if args.rest else (_die("delete-doc requires <id>")),
        "purge":             lambda: cmd_purge(cfg),
        "delete-datastore":  lambda: cmd_delete_datastore(cfg),
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
