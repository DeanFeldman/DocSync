from io import BytesIO
from pathlib import Path
import json
import sqlite3
import zipfile

from docx import Document
from fastapi.testclient import TestClient

from test_batch_editing import _load_test_app


MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_export_and_explicit_import_keep_history_and_validate_files(tmp_path: Path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    document = Document()
    document.add_paragraph("The original clause.")
    stream = BytesIO()
    document.save(stream)
    source = stream.getvalue()

    with TestClient(app) as client:
        library = client.get("/api/document-sets")
        assert library.status_code == 200, library.text
        assert library.json() == {"document_sets": []}
        upload = client.post(
            "/api/document-sets", data={"name": "Device-only workspace"},
            files=[("files", ("First.docx", source, MIME)), ("files", ("Second.docx", source, MIME))],
        )
        assert upload.status_code == 201, upload.text
        workspace = upload.json()
        listed = client.get("/api/document-sets")
        assert listed.status_code == 200, listed.text
        summary = listed.json()["document_sets"][0]
        assert summary["id"] == workspace["id"]
        assert summary["document_count"] == 2
        first = workspace["documents"][0]
        blocks = client.get(f"/api/document-versions/{first['version_id']}/editor-content").json()["blocks"]
        block_id = blocks[0]["element_id"]
        changed = client.post(f"/api/document-sets/{workspace['id']}/editor-generate", json={
            "base_versions": {first["id"]: first["version_id"]},
            "source_element_id": block_id,
            "edit_mode": "override",
            "targets": [{"element_id": block_id, "replacement_text": "An updated clause."}],
        })
        assert changed.status_code == 201, changed.text
        latest = changed.json()["versions"][0]["version_id"]
        download = client.get("/api/local-workspace/export?appearance=dark")
        assert download.status_code == 200, download.text if not download.is_success else ""
        archive = zipfile.ZipFile(BytesIO(download.content))
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "docsync-workspace"
        assert manifest["appearance"] == "dark"
        assert not {"user_id", "device_id", "supabase"} & manifest.keys()

        staged = client.post(
            "/api/local-workspace/imports",
            files={"archive": ("portable.zip", download.content, "application/zip")},
        )
        assert staged.status_code == 200, staged.text
        content = staged.json()
        assert (content["sets"], content["documents"], content["versions"]) == (1, 2, 5)
        assert client.get(f"/api/document-versions/{first['id']}/download").content == source
        assert b"An updated clause." in zipfile.ZipFile(BytesIO(
            client.get(f"/api/document-versions/{latest}/download").content
        )).read("word/document.xml")

        staged_root = tmp_path / "device-restore" / content["import_id"]
        with sqlite3.connect(staged_root / "documentsync.db") as snapshot:
            parent = snapshot.execute(
                "SELECT parent_version_id FROM document_versions WHERE id=?", (latest,)
            ).fetchone()
            assert parent == (first["version_id"],)
            assert snapshot.execute(
                "SELECT current_version_id FROM document_heads WHERE document_id=?", (first["id"],)
            ).fetchone() == (latest,)

        for malicious_name in ("source alteration", "originals/../outside.docx", "originals/CON.docx"):
            output = BytesIO()
            with zipfile.ZipFile(output, "w") as corrupted:
                for name in archive.namelist():
                    data = archive.read(name)
                    if malicious_name == "source alteration" and name.startswith("originals/"):
                        data = data + b"!"
                    corrupted.writestr(name, data)
                if malicious_name != "source alteration":
                    corrupted.writestr(malicious_name, b"invalid")
            rejected = client.post(
                "/api/local-workspace/imports",
                files={"archive": ("corrupted.zip", output.getvalue(), "application/zip")},
            )
            assert rejected.status_code == 422, rejected.text
        assert [entry.name for entry in staged_root.parent.iterdir()] == [content["import_id"]]
        assert client.get("/api/cloud-snapshots").status_code == 404
