from __future__ import annotations

from io import BytesIO
import importlib
from pathlib import Path
import sys
import time

from fastapi.testclient import TestClient
import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from app.text_inventory_service import build_text_inventory
from docx_inventory_fixtures import UNIQUE_PHRASE, make_exhaustive_text_inventory_docx


def _load_test_app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DOCUMENTSYNC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(
        "DOCUMENTSYNC_DATABASE_URL",
        f"sqlite:///{tmp_path / 'batch-editing.db'}",
    )
    monkeypatch.setenv("DOCUMENTSYNC_SESSION_TOKEN", "")
    monkeypatch.delenv("DOCUMENTSYNC_WEB_DIST", raising=False)
    for module_name in list(sys.modules):
        if module_name == "app" or module_name.startswith("app."):
            del sys.modules[module_name]
    return importlib.import_module("app.main").app


def _occurrence_payload(item: dict) -> dict:
    return {
        "occurrence_id": item["occurrence_id"],
        "segment_id": item["segment_id"],
        "document_id": item["document_id"],
        "version_id": item["version_id"],
        "element_id": item.get("element_id"),
        "part_path": item["part_path"],
        "structure_type": item["structure_type"],
        "match_start": item["match_start"],
        "match_end": item["match_end"],
        "matched_text": item["matched_text"],
        "location": item["location"],
        "editable": item["editable"],
        "read_only_reason": item.get("read_only_reason"),
    }


def _wait_for_generation(client: TestClient, operation_id: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/editor-operations/{operation_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"completed", "failed", "interrupted"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("Timed out waiting for batch generation.")


def test_durable_batch_applies_multiple_operations_once_per_document(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    source = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/document-sets",
            data={"name": "Batch workspace"},
            files=[
                ("files", ("Alpha.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        )
        assert uploaded.status_code == 201, uploaded.text
        workspace = uploaded.json()
        document_set_id = workspace["id"]

        found = client.post(
            f"/api/document-sets/{document_set_id}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        )
        assert found.status_code == 200, found.text
        editable = [item for item in found.json()["results"] if item["editable"]]
        by_document: dict[str, list[dict]] = {}
        for item in editable:
            by_document.setdefault(item["document_id"], []).append(item)
        assert len(by_document) == 2

        created = client.post(
            f"/api/document-sets/{document_set_id}/edit-batches",
            json={"title": "Terminology update"},
        )
        assert created.status_code == 201, created.text
        batch_id = created.json()["id"]

        first_targets = [_occurrence_payload(items[0]) for items in by_document.values()]
        first = client.post(
            f"/api/edit-batches/{batch_id}/operations",
            json={
                "operation_type": "find_replace",
                "label": "First occurrence in each file",
                "replacement_text": "DOCSYNC_BATCH_FIRST",
                "find_request": {"query": UNIQUE_PHRASE},
                "occurrences": first_targets,
            },
        )
        assert first.status_code == 201, first.text
        staged_occurrences = {
            occurrence["occurrence_id"]: occurrence
            for occurrence in first.json()["operations"][0]["occurrences"]
        }
        for target in first_targets:
            assert staged_occurrences[target["occurrence_id"]]["segment_text"] == next(
                item["text"]
                for item in editable
                if item["occurrence_id"] == target["occurrence_id"]
            )

        second_targets = [_occurrence_payload(items[1]) for items in by_document.values()]
        second = client.post(
            f"/api/edit-batches/{batch_id}/operations",
            json={
                "operation_type": "find_replace",
                "label": "Second occurrence in each file",
                "replacement_text": "DOCSYNC_BATCH_SECOND",
                "find_request": {"query": UNIQUE_PHRASE},
                "occurrences": second_targets,
            },
        )
        assert second.status_code == 201, second.text
        assert second.json()["operation_count"] == 2
        assert second.json()["affected_document_count"] == 2

        preview = client.post(f"/api/edit-batches/{batch_id}/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["status"] == "ready"
        assert preview.json()["affected_location_count"] == 4

        queued = client.post(f"/api/edit-batches/{batch_id}/generate")
        assert queued.status_code == 202, queued.text
        completed = _wait_for_generation(client, batch_id)
        assert completed["status"] == "completed", completed
        assert len(completed["result_version_ids"]) == 2

        detail = client.get(f"/api/edit-batches/{batch_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["status"] == "completed"
        assert all(
            occurrence["result_version_id"]
            for operation in detail.json()["operations"]
            for occurrence in operation["occurrences"]
        )

        for version in completed["versions"]:
            downloaded = client.get(
                f"/api/document-versions/{version['version_id']}/download"
            )
            assert downloaded.status_code == 200, downloaded.text
            inventory = build_text_inventory(
                downloaded.content,
                document_id=version["document_id"],
                version_id=version["version_id"],
            )
            text = "\n".join(segment.text for segment in inventory.segments)
            assert "DOCSYNC_BATCH_FIRST" in text
            assert "DOCSYNC_BATCH_SECOND" in text

        history = client.get(f"/api/document-sets/{document_set_id}/history")
        assert history.status_code == 200, history.text
        event = next(
            item
            for item in history.json()["events"]
            if item.get("generation_id") == batch_id
        )
        assert event["event_type"] == "batch_edit"
        assert event["version_count"] == 2
        assert event["target_count"] == 4
        assert len(event["batch_operations"]) == 2


def test_batch_preview_reports_duplicate_and_overlapping_occurrence_conflicts(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    source = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        workspace = client.post(
            "/api/document-sets",
            data={"name": "Conflict workspace"},
            files=[
                ("files", ("Alpha.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        ).json()
        found = client.post(
            f"/api/document-sets/{workspace['id']}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        ).json()
        target = _occurrence_payload(
            next(item for item in found["results"] if item["editable"])
        )
        batch = client.post(
            f"/api/document-sets/{workspace['id']}/edit-batches",
            json={"title": "Conflicted"},
        ).json()
        for replacement in ("FIRST", "SECOND"):
            added = client.post(
                f"/api/edit-batches/{batch['id']}/operations",
                json={
                    "operation_type": "find_replace",
                    "replacement_text": replacement,
                    "find_request": {"query": UNIQUE_PHRASE},
                    "occurrences": [target],
                },
            )
            assert added.status_code == 201, added.text

        preview = client.post(f"/api/edit-batches/{batch['id']}/preview")
        assert preview.status_code == 200, preview.text
        codes = {item["code"] for item in preview.json()["conflicts"]}
        assert {"duplicate_occurrence", "overlapping_occurrences"} <= codes

        generate = client.post(f"/api/edit-batches/{batch['id']}/generate")
        assert generate.status_code == 409, generate.text

        current = client.get(f"/api/document-sets/{workspace['id']}")
        assert current.status_code == 200, current.text
        assert current.json()["documents"][0]["version_number"] == 1


def test_draft_batch_survives_application_restart(tmp_path: Path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = client.post(
            "/api/document-sets",
            data={"name": "Restart workspace"},
            files=[
                ("files", ("Alpha.docx", make_exhaustive_text_inventory_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", make_exhaustive_text_inventory_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        ).json()
        batch = client.post(
            f"/api/document-sets/{workspace['id']}/edit-batches",
            json={"title": "Persistent pending changes"},
        ).json()

    restarted_app = _load_test_app(tmp_path, monkeypatch)
    with TestClient(restarted_app) as client:
        draft = client.get(
            f"/api/document-sets/{workspace['id']}/edit-batches/draft"
        )
        assert draft.status_code == 200, draft.text
        assert draft.json()["batch"]["id"] == batch["id"]
        assert draft.json()["batch"]["title"] == "Persistent pending changes"


def test_mid_batch_failure_rolls_back_every_document_and_removes_staging(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    source = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/document-sets",
            data={"name": "Rollback workspace"},
            files=[
                ("files", ("Alpha.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        ).json()
        found = client.post(
            f"/api/document-sets/{uploaded['id']}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        ).json()
        selected_by_document: dict[str, dict] = {}
        for item in found["results"]:
            if item["editable"]:
                selected_by_document.setdefault(item["document_id"], item)
        original_versions = {
            document["id"]: document["version_id"]
            for document in uploaded["documents"]
        }
        batch = client.post(
            f"/api/document-sets/{uploaded['id']}/edit-batches",
            json={"title": "Must roll back"},
        ).json()
        added = client.post(
            f"/api/edit-batches/{batch['id']}/operations",
            json={
                "operation_type": "find_replace",
                "replacement_text": "SHOULD_NOT_COMMIT",
                "find_request": {"query": UNIQUE_PHRASE},
                "occurrences": [
                    _occurrence_payload(item)
                    for item in selected_by_document.values()
                ],
            },
        )
        assert added.status_code == 201, added.text

        batch_service = importlib.import_module("app.batch_service")
        database = importlib.import_module("app.database")
        with database.SessionLocal() as session:
            preview = batch_service.preview_edit_batch(session, batch["id"])
            assert preview["status"] == "ready"
            batch_service.queue_edit_batch(session, batch["id"])

        real_apply = batch_service._apply_compiled_document
        calls = 0

        def fail_second_document(item):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("forced second-document failure")
            return real_apply(item)

        monkeypatch.setattr(
            batch_service,
            "_apply_compiled_document",
            fail_second_document,
        )
        with database.SessionLocal() as session:
            with pytest.raises(RuntimeError, match="forced second-document failure"):
                batch_service.generate_edit_batch(session, batch["id"])

        with database.SessionLocal() as session:
            models = importlib.import_module("app.models")
            heads = list(session.query(models.DocumentHead).all())
            assert {
                head.document_id: head.current_version_id for head in heads
            } == original_versions
            assert session.query(models.DocumentVersion).count() == 2

        generated_root = tmp_path / "data" / "generated" / uploaded["id"]
        assert not (generated_root / batch["id"]).exists()
        assert not (generated_root / f".{batch['id']}.staging").exists()


def test_editor_and_cross_structure_find_replace_share_one_document_version(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    source = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        workspace = client.post(
            "/api/document-sets",
            data={"name": "Mixed operation workspace"},
            files=[
                ("files", ("Alpha.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        ).json()
        alpha = next(item for item in workspace["documents"] if item["name"] == "Alpha.docx")
        search = client.post(
            f"/api/document-sets/{workspace['id']}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        ).json()
        header = next(
            item
            for item in search["results"]
            if item["document_id"] == alpha["id"]
            and item["structure_type"] == "header_paragraph"
            and item["editable"]
        )
        content = client.get(
            f"/api/document-versions/{alpha['version_id']}/editor-content"
        ).json()
        body_block = next(
            item
            for item in content["blocks"]
            if item["supported"]
            and not item["read_only"]
            and item["element_type"] in {"paragraph", "heading", "list_item"}
        )
        batch = client.post(
            f"/api/document-sets/{workspace['id']}/edit-batches",
            json={"title": "Mixed operation batch"},
        ).json()
        find_added = client.post(
            f"/api/edit-batches/{batch['id']}/operations",
            json={
                "operation_type": "find_replace",
                "replacement_text": "HEADER_BATCH_REPLACEMENT",
                "find_request": {"query": UNIQUE_PHRASE},
                "occurrences": [_occurrence_payload(header)],
            },
        )
        assert find_added.status_code == 201, find_added.text
        editor_added = client.post(
            f"/api/edit-batches/{batch['id']}/operations",
            json={
                "operation_type": "editor_replace",
                "label": "Rich editor body replacement",
                "editor_request": {
                    "base_versions": {alpha["id"]: alpha["version_id"]},
                    "source_element_id": body_block["element_id"],
                    "edit_mode": "per_document",
                    "targets": [
                        {
                            "element_id": body_block["element_id"],
                            "replacement_text": "EDITOR_BATCH_REPLACEMENT",
                        }
                    ],
                    "match_decisions": [],
                },
            },
        )
        assert editor_added.status_code == 201, editor_added.text

        preview = client.post(f"/api/edit-batches/{batch['id']}/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["status"] == "ready", preview.json()
        assert preview.json()["writes_performed"] is False
        changes = preview.json()["documents"][0]["changes"]
        assert {change["operation_type"] for change in changes} == {
            "editor_replace",
            "find_replace",
        }
        assert any(change["after"] == "EDITOR_BATCH_REPLACEMENT" for change in changes)
        assert any(change["after"] == "HEADER_BATCH_REPLACEMENT" for change in changes)
        queued = client.post(f"/api/edit-batches/{batch['id']}/generate")
        assert queued.status_code == 202, queued.text
        completed = _wait_for_generation(client, batch["id"])
        assert completed["status"] == "completed", completed
        assert len(completed["result_version_ids"]) == 1

        downloaded = client.get(
            f"/api/document-versions/{completed['result_version_ids'][0]}/download"
        )
        inventory = build_text_inventory(
            downloaded.content,
            document_id=alpha["id"],
            version_id=completed["result_version_ids"][0],
        )
        all_text = "\n".join(item.text for item in inventory.segments)
        assert "EDITOR_BATCH_REPLACEMENT" in all_text
        assert "HEADER_BATCH_REPLACEMENT" in all_text


def test_stale_batch_is_reported_before_any_batch_write(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    source = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        workspace = client.post(
            "/api/document-sets",
            data={"name": "Stale workspace"},
            files=[
                ("files", ("Alpha.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
                ("files", ("Beta.docx", source, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ],
        ).json()
        alpha = next(item for item in workspace["documents"] if item["name"] == "Alpha.docx")
        found = client.post(
            f"/api/document-sets/{workspace['id']}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        ).json()
        selected = next(
            item
            for item in found["results"]
            if item["document_id"] == alpha["id"] and item["editable"]
        )
        batch = client.post(
            f"/api/document-sets/{workspace['id']}/edit-batches",
            json={"title": "Will become stale"},
        ).json()
        added = client.post(
            f"/api/edit-batches/{batch['id']}/operations",
            json={
                "operation_type": "find_replace",
                "replacement_text": "STALE_BATCH_REPLACEMENT",
                "find_request": {"query": UNIQUE_PHRASE},
                "occurrences": [_occurrence_payload(selected)],
            },
        )
        assert added.status_code == 201, added.text

        editor_content = client.get(
            f"/api/document-versions/{alpha['version_id']}/editor-content"
        ).json()
        source_block = next(
            item
            for item in editor_content["blocks"]
            if item["supported"] and not item["read_only"]
        )
        changed = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json={
                "base_versions": {alpha["id"]: alpha["version_id"]},
                "source_element_id": source_block["element_id"],
                "edit_mode": "per_document",
                "targets": [
                    {
                        "element_id": source_block["element_id"],
                        "replacement_text": "A different committed change.",
                    }
                ],
                "match_decisions": [],
            },
        )
        assert changed.status_code == 201, changed.text

        preview = client.post(f"/api/edit-batches/{batch['id']}/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["status"] == "conflicted"
        assert "stale_base_version" in {
            conflict["code"] for conflict in preview.json()["conflicts"]
        }
        rejected = client.post(f"/api/edit-batches/{batch['id']}/generate")
        assert rejected.status_code == 409, rejected.text
        assert len(client.get(f"/api/documents/{alpha['id']}/versions").json()["versions"]) == 2
