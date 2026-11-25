import importlib
from io import BytesIO
from urllib.parse import urlsplit

from docx import Document
from fastapi.testclient import TestClient

from test_batch_editing import _load_test_app, _wait_for_generation


def _docx(text: str, *additional_paragraphs: str) -> bytes:
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    cell.text = text
    for paragraph in additional_paragraphs:
        cell.add_paragraph(paragraph)
    stream = BytesIO()
    doc.save(stream)
    return stream.getvalue()


def test_local_office_saved_copy_is_reviewed_and_applied_to_one_document(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.delenv("DOCSYNC_ONLYOFFICE_URL", raising=False)
    original = _docx("Original cell")
    changed = _docx("Changed cell")
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.get("/api/onlyoffice").json() == {"enabled": False}
        monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
        monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")
        uploaded = client.post("/api/document-sets", data={"name": "Local Office"}, files=[
            ("files", (name, content, office.MIME))
            for name, content in (
                ("One.docx", original), ("Two.docx", original), ("Three.docx", original),
                ("Near.docx", _docx("Original cell with extra text")),
                ("Duplicate.docx", _docx("Original cell", "Original cell")),
            )
        ])
        assert uploaded.status_code == 201, uploaded.text
        workspace = uploaded.json()
        documents = {document["name"]: document for document in workspace["documents"]}
        first, second, unselected = (documents[name] for name in ("One.docx", "Two.docx", "Three.docx"))
        version_id = first["version_id"]
        editor_api = f"/api/onlyoffice/{version_id}"
        opened = client.post(editor_api + "/open")
        assert opened.status_code == 200, opened.text
        embed_url = opened.json()["embed_url"]
        assert urlsplit(embed_url).hostname == "localhost"
        frame = client.get(embed_url)
        assert frame.status_code == 200, frame.text
        assert "X-Frame-Options" not in frame.headers
        assert "frame-ancestors http://127.0.0.1:8765" in frame.headers["Content-Security-Policy"]
        bridge_path = urlsplit(embed_url).path
        assert client.get(bridge_path).status_code == 404
        key = bridge_path.rsplit("/", 1)[-1]
        service = bridge_path.replace("onlyoffice-bridge", "onlyoffice-service")
        assert client.get(service + "/source").content == original
        assert client.get(service.replace(key, "not-the-key") + "/source").status_code == 404
        callback = service + "/callback"
        assert client.post(callback, json={"status": 6, "key": key}).status_code == 403

        def save(url: str):
            token = office._sign({"payload": {"status": 6, "key": key, "url": url}})
            return client.post(callback, json={}, headers={"Authorization": f"Bearer {token}"})

        assert save("http://example.test/draft.docx").status_code == 422
        monkeypatch.setattr(office, "_download_draft", lambda *_: changed)
        assert save("http://127.0.0.1:8080/draft.docx").json() == {"error": 0}
        assert client.get(f"/api/document-versions/{version_id}/download").content == original
        review = client.get(editor_api + "/review").json()
        assert "-Original cell" in review["changes"]
        assert "+Changed cell" in review["changes"]
        suggestions = {edit["document_name"]: edit for edit in review["related_edits"]}
        assert set(suggestions) == {"Two.docx", "Three.docx"}
        edit = suggestions["Two.docx"]
        assert edit["before"] == "Original cell"
        assert edit["after"] == "Changed cell"
        stage_request = {"draft_sha256": review["draft_sha256"], "target_ids": [edit["id"]]}
        stage_path = f"/api/documents/{first['id']}/onlyoffice/{version_id}/stage-related"
        assert client.post(stage_path, json={**stage_request, "target_ids": ["old-id"]}).status_code == 409
        staged = client.post(stage_path, json=stage_request)
        assert staged.status_code == 201, staged.text
        assert staged.json()["targets_added"] == 1
        assert client.post(stage_path, json=stage_request).json()["targets_added"] == 0
        assert client.get(f"/api/document-versions/{second['version_id']}/download").content == original

        apply = f"/api/documents/{first['id']}/onlyoffice/{version_id}/apply"
        assert client.post(apply, json={"draft_sha256": "stale"}).status_code == 409
        result = client.post(apply, json={"draft_sha256": review["draft_sha256"]})
        assert result.status_code == 201, result.text
        new_id = result.json()["version"]["version_id"]
        assert result.json()["operation_type"] == "external_edit"
        assert client.get(f"/api/document-versions/{new_id}/download").content == changed
        assert client.get(f"/api/document-versions/{second['version_id']}/download").content == original
        assert client.post(apply, json={"draft_sha256": review["draft_sha256"]}).status_code == 409

        batch_id = staged.json()["batch_id"]
        batch_url = f"/api/edit-batches/{batch_id}"
        preview = client.post(batch_url + "/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["status"] == "ready"
        assert [doc["document_id"] for doc in preview.json()["documents"]] == [second["id"]]
        generated = client.post(batch_url + "/generate")
        assert generated.status_code == 202, generated.text
        finished = _wait_for_generation(client, batch_id)
        assert finished["status"] == "completed", finished
        version_ids = finished["result_version_ids"]
        assert len(version_ids) == 1
        updated = client.get(f"/api/document-versions/{version_ids[0]}/download")
        assert Document(BytesIO(updated.content)).tables[0].cell(0, 0).text == "Changed cell"
        assert client.get(f"/api/document-versions/{unselected['version_id']}/download").content == original
