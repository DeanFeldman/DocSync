import importlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event
from urllib.parse import urlsplit

from docx import Document
from fastapi.testclient import TestClient
from sqlalchemy import select

from test_batch_editing import _load_test_app


def _docx(text: str, *additional_paragraphs: str) -> bytes:
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    cell.text = text
    for paragraph in additional_paragraphs:
        cell.add_paragraph(paragraph)
    stream = BytesIO()
    doc.save(stream)
    return stream.getvalue()


def test_local_office_saves_and_syncs_only_changed_shared_paragraphs(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    editor = importlib.import_module("app.editor_service")
    monkeypatch.delenv("DOCSYNC_ONLYOFFICE_URL", raising=False)
    original = _docx("Original\tcell", "Original source details", "Unchanged shared wording")
    changed = _docx("Changed cell", "Updated source details", "Unchanged shared wording")
    final = _docx("Final cell", "Updated source details", "Unchanged shared wording")
    target = _docx("Original\tcell", "Details unique to target", "Unchanged shared wording")
    with TestClient(app, base_url="http://127.0.0.1:8765", raise_server_exceptions=False) as client:
        assert client.get("/api/onlyoffice").json() == {"enabled": False}
        monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
        monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")
        uploaded = client.post("/api/document-sets", data={"name": "Local Office"}, files=[
            ("files", (name, content, office.MIME))
            for name, content in (
                ("One.docx", original), ("Two.docx", target), ("Three.docx", _docx("Original   cell", "Details unique to target", "Unchanged shared wording")),
                ("Near.docx", _docx("Original cell with extra text")),
                ("Duplicate.docx", _docx("Original cell", "Original cell")),
                ("Detached.docx", target),
            )
        ])
        assert uploaded.status_code == 201, uploaded.text
        workspace = uploaded.json()
        documents = {document["name"]: document for document in workspace["documents"]}
        first = documents["One.docx"]
        matching = [documents[name] for name in ("Two.docx", "Three.docx")]
        other = [documents[name] for name in ("Near.docx", "Duplicate.docx", "Detached.docx")]
        database = importlib.import_module("app.database")
        with database.SessionLocal() as session:
            detached = session.scalar(
                select(editor.DocumentBlockRevision).where(
                    editor.DocumentBlockRevision.version_id == documents["Detached.docx"]["version_id"],
                    editor.DocumentBlockRevision.text.like("Original%cell"),
                )
            )
            assert detached is not None
            detached.shared_state = "detached"
            session.commit()
        version_id = first["version_id"]
        editor_api = f"/api/onlyoffice/{version_id}"
        opened = client.post(f"/api/documents/{first['id']}/onlyoffice/open")
        assert opened.status_code == 200, opened.text
        assert opened.json()["version_id"] == version_id
        assert opened.json()["save_scope"] == "shared"
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
        second_editor_api = f"/api/onlyoffice/{matching[0]['version_id']}"
        second_opened = client.post(second_editor_api + "/open")
        assert second_opened.status_code == 200, second_opened.text
        second_path = urlsplit(second_opened.json()["embed_url"]).path
        second_callback = second_path.replace("onlyoffice-bridge", "onlyoffice-service") + "/callback"
        second_key = second_path.rsplit("/", 1)[-1]
        assert client.post(callback, json={"status": 6, "key": key}).status_code == 403

        saved_url = "http://127.0.0.1:8080/draft.docx"
        claims = {"operation": "callback", "status": 6, "key": key, "url": saved_url}

        def save_in_body(signed_claims: dict):
            return client.post(callback, json={
                "status": 1, "key": "unsigned-key", "url": "http://example.test/unsigned.docx",
                "token": office._sign(signed_claims),
            })

        assert save_in_body({**claims, "key": "different-key"}).status_code == 403
        assert save_in_body({**claims, "operation": "open"}).status_code == 403
        assert save_in_body({**claims, "url": "http://example.test/draft.docx"}).status_code == 422
        legacy_token = office._sign({"payload": {"status": 1, "key": key}})
        assert client.post(callback, json={}, headers={"Authorization": f"Bearer {legacy_token}"}).json() == {"error": 0}

        saved_bytes = changed

        def download_saved_draft(origin: str, url: str) -> bytes:
            assert origin == "http://127.0.0.1:8080"
            assert url == saved_url
            return saved_bytes

        monkeypatch.setattr(office, "_download_draft", download_saved_draft)
        replace_revisions = editor._replace_current_elements_and_create_revisions

        def fail_related_write(session, **kwargs):
            if kwargs["document"].id != first["id"]:
                raise RuntimeError("Injected failure while writing a matching document")
            return replace_revisions(session, **kwargs)

        with monkeypatch.context() as fail:
            fail.setattr(editor, "_replace_current_elements_and_create_revisions", fail_related_write)
            assert save_in_body(claims).status_code == 500
        failed = client.get(editor_api + "/save-status").json()
        assert failed["save"] is None and "save_error" in failed
        after_failure = client.get(f"/api/document-sets/{workspace['id']}").json()["documents"]
        assert {doc["id"]: doc["version_id"] for doc in after_failure} == {
            doc["id"]: doc["version_id"] for doc in documents.values()
        }
        started, release = Event(), Event()

        def wait_for_download(origin: str, url: str) -> bytes:
            started.set()
            assert release.wait(timeout=10)
            return download_saved_draft(origin, url)

        with monkeypatch.context() as pause, ThreadPoolExecutor(max_workers=1) as executor:
            pause.setattr(office, "_download_draft", wait_for_download)
            save = executor.submit(save_in_body, claims)
            try:
                assert started.wait(timeout=10)
                assert client.get(editor_api + "/save-status").json() == {"save": None, "saving": True}
            finally:
                release.set()
            assert save.result(timeout=15).json() == {"error": 0}

        def verify_saved_versions(text, source_content, previous=None):
            status = client.get(editor_api + "/save-status")
            assert status.status_code == 200, status.text
            result = status.json()["save"]
            versions = {item["document_id"]: item for item in result["versions"]}
            assert set(versions) == {first["id"], *(doc["id"] for doc in matching)}
            current_ids = {doc["id"]: doc["version_id"] for doc in result["document_set"]["documents"]}
            assert client.get(f"/api/document-versions/{current_ids[first['id']]}/download").content == source_content
            for doc in matching:
                content = client.get(f"/api/document-versions/{current_ids[doc['id']]}/download").content
                cell = Document(BytesIO(content)).tables[0].cell(0, 0)
                expected = text.replace(" ", "   " if doc["name"] == "Three.docx" else "\t")
                assert [paragraph.text for paragraph in cell.paragraphs] == [
                    expected, "Details unique to target", "Unchanged shared wording",
                ]
            assert all(current_ids[doc["id"]] == doc["version_id"] for doc in other)
            if previous:
                assert all(item["parent_version_id"] == previous[doc_id] for doc_id, item in versions.items())
            return result["operation_id"], current_ids

        operation_id, first_ids = verify_saved_versions("Changed cell", changed)
        skipped = client.get(editor_api + "/save-status").json()["save"]["skipped_documents"]
        assert {row["document_name"]: row["reasons"] for row in skipped} == {
            "Detached.docx": ["detached"],
            "Duplicate.docx": ["ambiguous"],
        }
        stale_token = office._sign({**claims, "key": second_key})
        assert client.post(second_callback, json={"token": stale_token}).status_code == 409
        assert client.get(service + "/source").content == changed
        assert client.get(f"/api/document-versions/{version_id}/download").content == original

        # Retry without creating duplicate versions.
        assert save_in_body(claims).json() == {"error": 0}
        assert client.get(editor_api + "/save-status", params={"after_operation": operation_id}).json() == {"save": None}
        assert verify_saved_versions("Changed cell", changed)[1] == first_ids

        # Keep editing with the original editor key after the source gets a new version.
        saved_bytes = final
        assert save_in_body(claims).json() == {"error": 0}
        _, final_ids = verify_saved_versions("Final cell", final, first_ids)

        saved_bytes = _docx("Updated source details", "Unchanged shared wording")
        assert save_in_body(claims).json() == {"error": 0}
        shared_version_ids = verify_saved_versions("", saved_bytes, final_ids)[1]
        scope_path = editor_api + "/save-scope"
        assert client.put(scope_path, json={"scope": "invalid"}).status_code == 422
        assert client.put(scope_path, json={"scope": "document"}).json() == {"save_scope": "document"}
        saved_bytes = _docx("Updated source details", "Private wording for this file")
        assert save_in_body(claims).json() == {"error": 0}
        result = client.get(editor_api + "/save-status").json()["save"]
        assert [item["document_id"] for item in result["versions"]] == [first["id"]]
        current = {item["id"]: item["version_id"] for item in result["document_set"]["documents"]}
        assert all(current[doc["id"]] == shared_version_ids[doc["id"]] for doc in matching)
        assert client.get(f"/api/document-versions/{current[first['id']]}/download").content == saved_bytes

        rename_path = f"/api/document-sets/{workspace['id']}/documents/{first['id']}"
        assert client.patch(rename_path, json={"name": "../escape"}).status_code == 422
        assert client.patch(rename_path, json={"name": "two.DOCX"}).status_code == 409
        renamed = client.patch(rename_path, json={"name": "Renamed agreement"})
        assert renamed.json() == {"id": first["id"], "name": "Renamed agreement.docx"}
        downloaded = client.get(f"/api/documents/{first['id']}/download")
        assert downloaded.content == saved_bytes
        assert "Renamed%20agreement.docx" in downloaded.headers["content-disposition"]
        after_rename = client.get(f"/api/document-sets/{workspace['id']}").json()["documents"]
        assert {item["id"]: item["version_id"] for item in after_rename} == current


def test_local_office_syncs_new_paragraphs_only_at_shared_locations(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    def document(body, table=()):
        doc = Document()
        for text in body:
            doc.add_paragraph(text)
        if table:
            cell = doc.add_table(rows=1, cols=1).cell(0, 0)
            cell.text = table[0]
            for text in table[1:]:
                cell.add_paragraph(text)
        output = BytesIO()
        doc.save(output)
        return output.getvalue()

    shared_body = ("Opening terms", "Existing charges", "", "Closing terms")
    shared_table = ("Payment terms", "Bank details")
    matching_table = ("Payment terms", "Target bank details")
    originals = {
        "Source.docx": document((*shared_body, "Source account"), shared_table),
        "Matching.docx": document((*shared_body, "Target account"), matching_table),
        "Different.docx": document(("Unique opening", "Existing charges", "Existing local text",
                                    "Different closing terms", "Different account"), ("Other terms", "Bank details")),
    }
    edited_body = ("", "Opening terms", "New standalone clause", "Existing charges",
                   "New text in a blank paragraph", "Closing terms", "")
    edited_table = ("Payment terms", "New payment requirement", "", "Bank details")
    edited = document((*edited_body, "Source account"), edited_table)
    originals["Already added.docx"] = document(
        ("Unrelated file details",), (*edited_table[:-1], "A third bank account"),
    )
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        upload = client.post("/api/document-sets", data={"name": "Shared additions"}, files=[
            ("files", (name, data, office.MIME)) for name, data in originals.items()
        ])
        assert upload.status_code == 201, upload.text
        docs = {row["name"]: row for row in upload.json()["documents"]}
        source = docs["Source.docx"]
        session = client.post(f"/api/documents/{source['id']}/onlyoffice/open").json()
        path = urlsplit(session["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        key = path.rsplit("/", 1)[-1]
        callback = path + "/callback"
        editor_api = f"/api/onlyoffice/{session['version_id']}"
        token = office._sign({
            "operation": "callback", "status": 6, "key": key, "url": "http://127.0.0.1:8080/edited.docx",
        })
        monkeypatch.setattr(office, "_download_draft", lambda *_: edited)
        result = client.post(callback, json={"token": token})
        assert result.json() == {"error": 0}, result.text

        saved = client.get(editor_api + "/save-status").json()["save"]
        updated = {row["name"]: row for row in saved["document_set"]["documents"]}
        assert updated["Different.docx"]["version_id"] == docs["Different.docx"]["version_id"]
        assert updated["Already added.docx"]["version_id"] == docs["Already added.docx"]["version_id"]
        matching = client.get(updated["Matching.docx"]["download_url"])
        version = Document(BytesIO(matching.content))
        assert tuple(p.text for p in version.paragraphs) == (*edited_body, "Target account")
        assert tuple(p.text for p in version.tables[0].cell(0, 0).paragraphs) == (
            *edited_table[:-1], "Target bank details",
        )

        assert client.post(callback, json={"token": token}).json() == {"error": 0}
        assert client.get(editor_api + "/save-status", params={
            "after_operation": saved["operation_id"],
        }).json() == {"save": None}


def test_local_office_repeated_insertions_beside_a_word_line_break(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")
    originals = {
        "Source.docx": _docx("Shared opening\nTerms follow", "Source details"),
        "Line break.docx": _docx("Shared opening\nTerms follow", "Target details"),
        "Spaces.docx": _docx("Shared opening   Terms follow", "Different target details"),
    }
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        upload = client.post("/api/document-sets", data={"name": "Insertion beside a line break"}, files=[
            ("files", (name, data, office.MIME)) for name, data in originals.items()
        ])
        assert upload.status_code == 201, upload.text
        documents = {row["name"]: row for row in upload.json()["documents"]}
        source = documents["Source.docx"]
        editor = client.post(f"/api/documents/{source['id']}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })
        previous_versions = {name: row["version_id"] for name, row in documents.items()}
        for words in ("New condition. ", "Another condition. New condition. "):
            draft = _docx("Shared opening\n" + words + "Terms follow", "Source details")
            monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
            result = client.post(service + "/callback", json={"token": token})
            assert result.json() == {"error": 0}, result.text
            saved = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
            assert {row["name"] for row in saved["affected_documents"]} == set(documents)
            assert saved["skipped_documents"] == []
            for row in saved["document_set"]["documents"]:
                name = row["name"]
                assert row["version_id"] != previous_versions[name]
                previous_versions[name] = row["version_id"]
                cell = Document(BytesIO(client.get(row["download_url"]).content)).tables[0].cell(0, 0)
                gap = "   " if name == "Spaces.docx" else "\n"
                expected_details = Document(BytesIO(originals[name])).tables[0].cell(0, 0).paragraphs[1].text
                assert cell.paragraphs[0].text == "Shared opening" + gap + words + "Terms follow"
                assert cell.paragraphs[1].text == expected_details
