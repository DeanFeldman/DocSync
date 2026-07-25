from __future__ import annotations

import hashlib
import importlib
import io
import os
import sys
import zipfile
from pathlib import Path

from docx import Document
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


def load_test_app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DOCUMENTSYNC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(
        "DOCUMENTSYNC_DATABASE_URL",
        f"sqlite:///{tmp_path / 'editor-workflow.db'}",
    )
    monkeypatch.setenv("DOCUMENTSYNC_SESSION_TOKEN", "")
    monkeypatch.setenv("DOCUMENTSYNC_NEAR_MATCH_THRESHOLD", "0.82")
    monkeypatch.delenv("DOCUMENTSYNC_WEB_DIST", raising=False)

    for module_name in list(sys.modules):
        if module_name == "app" or module_name.startswith("app."):
            del sys.modules[module_name]

    return importlib.import_module("app.main").app


def save_docx(document: Document) -> bytes:
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def make_paragraph_docx(title: str, paragraphs: list[str]) -> bytes:
    document = Document()
    document.add_heading(title, level=1)
    for text in paragraphs:
        document.add_paragraph(text)
    return save_docx(document)


def make_rich_docx(exact_text: str, near_text: str) -> bytes:
    document = Document()
    document.add_heading("Rich editor contract", level=1)

    rich = document.add_paragraph()
    bold = rich.add_run("Bold")
    bold.bold = True
    italic = rich.add_run(" Italic")
    italic.italic = True
    underlined = rich.add_run(" Underlined")
    underlined.underline = True

    document.add_paragraph("First numbered item", style="List Number")
    document.add_paragraph("Indented bullet item", style="List Bullet 2")
    document.add_paragraph(exact_text)
    document.add_paragraph(near_text)
    return save_docx(document)


def make_read_only_table_docx(shared_text: str) -> bytes:
    document = Document()
    document.add_heading("Read-only structures", level=1)
    document.add_paragraph(shared_text)
    table = document.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    cell.paragraphs[0].text = "Read-only first line"
    cell.add_paragraph("Read-only second line")
    return save_docx(document)


def upload_set(
    client: TestClient,
    originals: dict[str, bytes],
    *,
    name: str = "Editor workflow",
) -> dict:
    response = client.post(
        "/api/document-sets",
        data={"name": name},
        files=[
            (
                "files",
                (filename, io.BytesIO(payload), DOCX_MEDIA_TYPE),
            )
            for filename, payload in originals.items()
        ],
    )
    assert response.status_code == 201, response.text
    return response.json()


def documents_by_name(workspace: dict) -> dict[str, dict]:
    return {document["name"]: document for document in workspace["documents"]}


def read_editor_content(client: TestClient, version_id: str) -> dict:
    response = client.get(f"/api/document-versions/{version_id}/editor-content")
    assert response.status_code == 200, response.text
    return response.json()


def block_with_text(content: dict, text: str) -> dict:
    return next(block for block in content["blocks"] if block["text"] == text)


def current_versions(workspace: dict, document_names: list[str]) -> dict[str, str]:
    by_name = documents_by_name(workspace)
    return {
        by_name[name]["id"]: by_name[name]["version_id"]
        for name in document_names
    }


def version_count(client: TestClient, document_id: str) -> int:
    response = client.get(f"/api/documents/{document_id}/versions")
    assert response.status_code == 200, response.text
    return len(response.json()["versions"])


def test_editor_content_preserves_delta_structure_and_normalized_matching(
    tmp_path: Path,
    monkeypatch,
) -> None:
    exact_a = "Ｔhe RESIDENT   submits the safety report every month."
    exact_b = "the resident submits the safety report every month."
    near_a = "The caretaker completes the inspection every Friday."
    near_c = "The caretaker completes the inspection every Monday."
    originals = {
        "Alpha.docx": make_rich_docx(exact_a, near_a),
        "Beta.docx": make_paragraph_docx("Beta contract", [exact_b]),
        "Gamma.docx": make_paragraph_docx("Gamma contract", [near_c]),
    }

    app = load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = upload_set(client, originals)
        documents = documents_by_name(workspace)
        alpha = read_editor_content(client, documents["Alpha.docx"]["version_id"])
        beta = read_editor_content(client, documents["Beta.docx"]["version_id"])
        gamma = read_editor_content(client, documents["Gamma.docx"]["version_id"])

        rich = block_with_text(alpha, "Bold Italic Underlined")
        assert rich["delta"] == {
            "ops": [
                {"insert": "Bold", "attributes": {"bold": True}},
                {"insert": " Italic", "attributes": {"italic": True}},
                {"insert": " Underlined", "attributes": {"underline": True}},
                {"insert": "\n"},
            ]
        }
        assert rich["formatting"]["runs"] == [
            {"text": "Bold", "bold": True},
            {"text": " Italic", "italic": True},
            {"text": " Underlined", "underline": True},
        ]

        heading = block_with_text(alpha, "Rich editor contract")
        assert heading["element_type"] == "heading"
        assert heading["delta"]["ops"][-1] == {
            "insert": "\n",
            "attributes": {"header": 1},
        }

        numbered = block_with_text(alpha, "First numbered item")
        assert numbered["element_type"] == "list_item"
        assert numbered["list_type"] == "ordered"
        assert numbered["list_level"] == 0
        assert numbered["delta"]["ops"][-1]["attributes"] == {"list": "ordered"}

        bullet = block_with_text(alpha, "Indented bullet item")
        assert bullet["element_type"] == "list_item"
        assert bullet["list_type"] == "bullet"
        assert bullet["list_level"] == 1
        assert bullet["delta"]["ops"][-1]["attributes"] == {
            "list": "bullet",
            "indent": 1,
        }

        source = block_with_text(alpha, exact_a)
        exact_candidate = block_with_text(beta, exact_b)
        assert source["normalized_text"] == exact_candidate["normalized_text"]
        assert source["normalized_text"] == (
            "the resident submits the safety report every month."
        )
        assert source["exact_match_hash"] == exact_candidate["exact_match_hash"]

        matches = client.get(
            f"/api/document-elements/{source['element_id']}/matches"
        )
        assert matches.status_code == 200, matches.text
        assert matches.json()["exact_match_count"] == 1
        assert matches.json()["exact_matches"][0]["element_id"] == (
            exact_candidate["element_id"]
        )
        assert matches.json()["exact_matches"][0]["match_type"] == "exact"

        near_source = block_with_text(alpha, near_a)
        near_candidate = block_with_text(gamma, near_c)
        compared = client.post(
            f"/api/document-elements/{near_source['element_id']}/compare",
            json={"candidate_element_ids": [near_candidate["element_id"]]},
        )
        assert compared.status_code == 200, compared.text
        comparison = compared.json()["items"][0]
        assert comparison["match_type"] == "near"
        assert 0 < comparison["similarity_score"] < 1
        assert comparison["diff_spans"] == comparison["difference_spans"]
        assert any(
            span["kind"] == "equal" and span["text"]
            for span in comparison["difference_spans"]
        )
        assert any(
            span["kind"] == "changed"
            and span["source_text"] == "Friday"
            and span["candidate_text"] == "Monday"
            for span in comparison["difference_spans"]
        )

        discovered = client.get(
            f"/api/document-elements/{near_source['element_id']}/similar-matches",
            params={"threshold": 0, "limit": 20},
        )
        assert discovered.status_code == 200, discovered.text
        discovered_candidate = next(
            item
            for item in discovered.json()["matches"]
            if item["element_id"] == near_candidate["element_id"]
        )
        assert discovered_candidate["match_type"] == "near"
        assert discovered_candidate["algorithm_version"] if (
            "algorithm_version" in discovered_candidate
        ) else discovered.json()["algorithm_version"] == "nfkc-sequence-v1"


def test_match_decisions_persist_and_control_near_match_targets(
    tmp_path: Path,
    monkeypatch,
) -> None:
    texts = {
        "Alpha.docx": "The resident submits the safety report every month.",
        "Beta.docx": "The resident submits the safety report each month.",
        "Gamma.docx": "The resident submits the safety report every calendar month.",
        "Delta.docx": "The resident submits the safety report every single month.",
    }
    originals = {
        name: make_paragraph_docx("Common heading", [text])
        for name, text in texts.items()
    }

    app = load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = upload_set(client, originals)
        documents = documents_by_name(workspace)
        contents = {
            name: read_editor_content(client, document["version_id"])
            for name, document in documents.items()
        }
        blocks = {
            name: block_with_text(contents[name], text)
            for name, text in texts.items()
        }
        source = blocks["Alpha.docx"]

        saved = client.post(
            f"/api/document-elements/{source['element_id']}/match-decisions",
            json={
                "decisions": [
                    {
                        "candidate_element_id": blocks["Beta.docx"]["element_id"],
                        "status": "confirmed",
                    },
                    {
                        "candidate_element_id": blocks["Gamma.docx"]["element_id"],
                        "status": "ignored",
                    },
                    {
                        "candidate_element_id": blocks["Delta.docx"]["element_id"],
                        "status": "removed",
                    },
                ]
            },
        )
        assert saved.status_code == 200, saved.text
        assert {
            item["candidate_element_id"]: item["status"]
            for item in saved.json()["decisions"]
        } == {
            blocks["Beta.docx"]["element_id"]: "confirmed",
            blocks["Gamma.docx"]["element_id"]: "ignored",
            blocks["Delta.docx"]["element_id"]: "removed",
        }

        reloaded = client.get(
            f"/api/document-elements/{source['element_id']}/similar-matches",
            params={"threshold": 0},
        )
        assert reloaded.status_code == 200, reloaded.text
        persisted = {
            item["element_id"]: item["decision"]
            for item in reloaded.json()["matches"]
        }
        assert persisted[blocks["Beta.docx"]["element_id"]] == "confirmed"
        assert persisted[blocks["Gamma.docx"]["element_id"]] == "ignored"
        assert persisted[blocks["Delta.docx"]["element_id"]] == "removed"

        confirmed_request = {
            "base_versions": current_versions(
                workspace, ["Alpha.docx", "Beta.docx"]
            ),
            "source_element_id": source["element_id"],
            "edit_mode": "shared",
            "targets": [
                {
                    "element_id": source["element_id"],
                    "replacement_text": "The revised safety report is due monthly.",
                },
                {
                    "element_id": blocks["Beta.docx"]["element_id"],
                    "replacement_text": "The revised safety report is due monthly.",
                },
            ],
        }
        accepted = client.post(
            f"/api/document-sets/{workspace['id']}/editor-preview",
            json=confirmed_request,
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["affected_document_count"] == 2

        for name in ("Gamma.docx", "Delta.docx"):
            rejected = client.post(
                f"/api/document-sets/{workspace['id']}/editor-preview",
                json={
                    "base_versions": current_versions(
                        workspace, ["Alpha.docx", name]
                    ),
                    "source_element_id": source["element_id"],
                    "edit_mode": "shared",
                    "targets": [
                        {
                            "element_id": source["element_id"],
                            "replacement_text": "Revised source",
                        },
                        {
                            "element_id": blocks[name]["element_id"],
                            "replacement_text": "Revised candidate",
                        },
                    ],
                },
            )
            assert rejected.status_code == 422
            assert "confirmed" in rejected.json()["detail"].casefold()


def test_preview_is_side_effect_free_and_generation_is_target_specific_and_versioned(
    tmp_path: Path,
    monkeypatch,
) -> None:
    shared = "The manager submits the compliance report every month."
    originals = {
        "Alpha.docx": make_paragraph_docx("Alpha agreement", [shared]),
        "Beta.docx": make_paragraph_docx("Beta agreement", [shared]),
    }

    app = load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = upload_set(client, originals)
        documents = documents_by_name(workspace)
        contents = {
            name: read_editor_content(client, document["version_id"])
            for name, document in documents.items()
        }
        blocks = {
            name: block_with_text(contents[name], shared)
            for name in documents
        }
        original_version_ids = {
            name: document["version_id"] for name, document in documents.items()
        }
        original_checksums = {
            name: hashlib.sha256(payload).hexdigest()
            for name, payload in originals.items()
        }
        request = {
            "base_versions": current_versions(
                workspace, ["Alpha.docx", "Beta.docx"]
            ),
            "source_element_id": blocks["Alpha.docx"]["element_id"],
            "edit_mode": "per_document",
            "targets": [
                {
                    "element_id": blocks["Alpha.docx"]["element_id"],
                    "replacement_text": "Alpha submits its report every Friday.",
                },
                {
                    "element_id": blocks["Beta.docx"]["element_id"],
                    "replacement_text": "Beta submits its report every Monday.",
                },
            ],
        }

        preview = client.post(
            f"/api/document-sets/{workspace['id']}/editor-preview",
            json=request,
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["status"] == "previewed"
        assert preview.json()["writes_performed"] is False
        assert preview.json()["affected_document_count"] == 2
        assert preview.json()["affected_location_count"] == 2
        assert {
            (item["document_name"], item["changes"][0]["after"])
            for item in preview.json()["documents"]
        } == {
            ("Alpha.docx", "Alpha submits its report every Friday."),
            ("Beta.docx", "Beta submits its report every Monday."),
        }
        for name, document in documents.items():
            assert version_count(client, document["id"]) == 1
            original_download = client.get(
                f"/api/document-versions/{original_version_ids[name]}/download"
            )
            assert original_download.status_code == 200
            assert original_download.content == originals[name]
        history_before = client.get(
            f"/api/document-sets/{workspace['id']}/history"
        )
        assert history_before.status_code == 200
        assert history_before.json()["events"] == []

        generated = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json=request,
        )
        assert generated.status_code == 201, generated.text
        result = generated.json()
        assert result["status"] == "completed"
        assert result["edit_mode"] == "per_document"
        assert len(result["versions"]) == 2

        generated_by_name = {
            item["document_name"]: item for item in result["versions"]
        }
        expected_replacements = {
            "Alpha.docx": "Alpha submits its report every Friday.",
            "Beta.docx": "Beta submits its report every Monday.",
        }
        for name, document in documents.items():
            version = generated_by_name[name]
            assert version["version_number"] == 2
            assert version["parent_version_id"] == original_version_ids[name]
            assert version["checksum_sha256"] != original_checksums[name]

            versions_response = client.get(
                f"/api/documents/{document['id']}/versions"
            )
            assert versions_response.status_code == 200
            versions_payload = versions_response.json()
            assert versions_payload["current_version_id"] == version["version_id"]
            assert [
                item["version_number"] for item in versions_payload["versions"]
            ] == [2, 1]
            assert versions_payload["versions"][0]["parent_version_id"] == (
                original_version_ids[name]
            )
            assert versions_payload["versions"][1]["parent_version_id"] is None
            assert versions_payload["versions"][1]["checksum_sha256"] == (
                original_checksums[name]
            )

            original_download = client.get(
                f"/api/document-versions/{original_version_ids[name]}/download"
            )
            assert original_download.status_code == 200
            assert original_download.content == originals[name]
            assert hashlib.sha256(original_download.content).hexdigest() == (
                original_checksums[name]
            )

            generated_download = client.get(version["download_url"])
            assert generated_download.status_code == 200
            assert hashlib.sha256(generated_download.content).hexdigest() == (
                version["checksum_sha256"]
            )
            edited_docx = Document(io.BytesIO(generated_download.content))
            assert expected_replacements[name] in [
                paragraph.text for paragraph in edited_docx.paragraphs
            ]
            unexpected = (
                expected_replacements["Beta.docx"]
                if name == "Alpha.docx"
                else expected_replacements["Alpha.docx"]
            )
            assert unexpected not in [
                paragraph.text for paragraph in edited_docx.paragraphs
            ]

            current_download = client.get(
                f"/api/documents/{document['id']}/download"
            )
            assert current_download.status_code == 200
            assert current_download.content == generated_download.content

        archive = client.get(result["download_url"])
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert set(bundle.namelist()) == set(originals)
            for name, replacement in expected_replacements.items():
                bundled = Document(io.BytesIO(bundle.read(name)))
                assert replacement in [
                    paragraph.text for paragraph in bundled.paragraphs
                ]

        stale = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json=request,
        )
        assert stale.status_code == 409
        assert "changed after this edit was opened" in stale.json()["detail"]
        assert all(
            version_count(client, document["id"]) == 2
            for document in documents.values()
        )


def test_full_override_detaches_block_and_excludes_it_from_shared_matches(
    tmp_path: Path,
    monkeypatch,
) -> None:
    shared = "This clause remains deliberately identical."
    originals = {
        "Alpha.docx": make_paragraph_docx("Alpha", [shared]),
        "Beta.docx": make_paragraph_docx("Beta", [shared]),
    }

    app = load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = upload_set(client, originals)
        documents = documents_by_name(workspace)
        alpha_content = read_editor_content(
            client, documents["Alpha.docx"]["version_id"]
        )
        beta_content = read_editor_content(
            client, documents["Beta.docx"]["version_id"]
        )
        alpha_source = block_with_text(alpha_content, shared)
        beta_source = block_with_text(beta_content, shared)

        generated = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json={
                "base_versions": current_versions(workspace, ["Alpha.docx"]),
                "source_element_id": alpha_source["element_id"],
                "edit_mode": "full_override",
                "targets": [
                    {
                        "element_id": alpha_source["element_id"],
                        "replacement_text": shared,
                    }
                ],
            },
        )
        assert generated.status_code == 201, generated.text
        assert generated.json()["edit_mode"] == "override"
        assert len(generated.json()["versions"]) == 1
        alpha_version = generated.json()["versions"][0]
        assert alpha_version["document_name"] == "Alpha.docx"

        detached_content = read_editor_content(
            client, alpha_version["version_id"]
        )
        detached = block_with_text(detached_content, shared)
        assert detached["shared_state"] == "detached"
        assert detached["detached_from_shared"] is True

        beta_matches = client.get(
            f"/api/document-elements/{beta_source['element_id']}/matches"
        )
        assert beta_matches.status_code == 200, beta_matches.text
        assert beta_matches.json()["exact_match_count"] == 0
        assert beta_matches.json()["exact_matches"] == []

        detached_matches = client.get(
            f"/api/document-elements/{detached['element_id']}/matches"
        )
        assert detached_matches.status_code == 200, detached_matches.text
        assert detached_matches.json()["exact_match_count"] == 0
        assert detached_matches.json()["exact_matches"] == []

        beta_versions = client.get(
            f"/api/documents/{documents['Beta.docx']['id']}/versions"
        )
        assert beta_versions.status_code == 200
        assert len(beta_versions.json()["versions"]) == 1


def test_invalid_delta_and_unsupported_block_leave_no_version_or_operation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    shared = "A normal editable paragraph."
    originals = {
        "Alpha.docx": make_read_only_table_docx(shared),
        "Beta.docx": make_paragraph_docx("Beta", [shared]),
    }

    app = load_test_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        workspace = upload_set(client, originals)
        documents = documents_by_name(workspace)
        alpha = read_editor_content(client, documents["Alpha.docx"]["version_id"])
        editable = block_with_text(alpha, shared)
        read_only = next(
            block
            for block in alpha["blocks"]
            if block["element_type"] == "table_cell"
        )
        assert read_only["supported"] is False
        assert read_only["read_only"] is True
        assert "multiple paragraphs" in read_only["unsupported_reason"]

        invalid_delta = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json={
                "base_versions": current_versions(workspace, ["Alpha.docx"]),
                "source_element_id": editable["element_id"],
                "edit_mode": "per_document",
                "targets": [
                    {
                        "element_id": editable["element_id"],
                        "replacement_text": shared,
                        "delta": {"ops": [{"retain": 1}]},
                    }
                ],
            },
        )
        assert invalid_delta.status_code == 422
        assert "retain/delete operations are unsupported" in (
            invalid_delta.json()["detail"]
        )

        unsupported = client.post(
            f"/api/document-sets/{workspace['id']}/editor-generate",
            json={
                "base_versions": current_versions(workspace, ["Alpha.docx"]),
                "source_element_id": read_only["element_id"],
                "edit_mode": "override",
                "targets": [
                    {
                        "element_id": read_only["element_id"],
                        "replacement_text": "Attempted replacement",
                    }
                ],
            },
        )
        assert unsupported.status_code == 422
        assert "multiple paragraphs" in unsupported.json()["detail"]

        for document in documents.values():
            versions = client.get(
                f"/api/documents/{document['id']}/versions"
            )
            assert versions.status_code == 200
            assert len(versions.json()["versions"]) == 1
            assert versions.json()["current_version_id"] == document["version_id"]

        history = client.get(f"/api/document-sets/{workspace['id']}/history")
        assert history.status_code == 200
        assert history.json()["events"] == []
        generated_root = tmp_path / "data" / "generated"
        assert list(generated_root.rglob("*")) == []
