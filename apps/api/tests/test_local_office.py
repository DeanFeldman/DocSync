import importlib
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event
from urllib.parse import urlsplit

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
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


def test_desktop_configures_local_office_at_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_CONTROL_TOKEN", "control-secret")
    monkeypatch.delenv("DOCSYNC_ONLYOFFICE_URL", raising=False)
    app = _load_test_app(tmp_path, monkeypatch, session_token="desktop-session")
    office = importlib.import_module("app.local_office")
    settings = {
        "origin": "http://127.0.0.1:8080",
        "secret": "onlyoffice-test-signing-secret",
        "relayHost": "172.26.208.1",
        "relayPort": 18452,
    }
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        headers = {"Authorization": "Bearer control-secret"}
        runtime = "/api/onlyoffice/runtime"
        assert "frame-src 'self' http://localhost:8765" in client.get("/api/health").headers["Content-Security-Policy"]
        assert client.put(runtime, json=settings, headers=headers).status_code == 401
        client.cookies.set("docsync_session", "desktop-session")
        assert client.put(runtime, json=settings).status_code == 403
        assert client.put(runtime, json={**settings, "relayHost": "8.8.8.8"}, headers=headers).status_code == 422
        assert client.get("/api/onlyoffice").json() == {"enabled": False}
        assert client.put(runtime, json=settings, headers=headers).status_code == 204
        assert client.get("/api/onlyoffice").json() == {"enabled": True}
        upload = client.post("/api/document-sets", data={"name": "Local editor"}, files=[
            ("files", (name, _docx("Common wording"), office.MIME))
            for name in ("One.docx", "Two.docx")
        ])
        doc = upload.json()["documents"][0]
        editor = client.post(f"/api/documents/{doc['id']}/onlyoffice/open")
        assert editor.status_code == 200
        bridge = client.get(editor.json()["embed_url"])
        assert bridge.status_code == 200
        assert "http://172.26.208.1:18452/8765/onlyoffice-service/" in bridge.text
        assert settings["secret"] not in bridge.text


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
                    *([expected] if expected else []), "Details unique to target", "Unchanged shared wording",
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



def test_local_office_syncs_mixed_wording_and_paragraph_edits_in_one_save(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    original = (
        "Opening shared terms", "The buyer must promptly pay the deposit", "Closing shared terms",
        "", "Shared anchor after blank", "Obsolete shared paragraph", "Last shared terms",
        "Clear this shared paragraph", "End of common terms",
    )
    edited = (
        "Opening shared terms", "The buyer must pay the deposit by Friday", "",
        "A new standalone condition", "Closing shared terms", "Shared anchor after blank",
        "Last shared terms with a new ending", "", "End of common terms",
    )
    matching_with_distinct_wording = (*original, "Target-specific terms")
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        upload = client.post("/api/document-sets", data={"name": "Mixed paragraph edits"}, files=[
            ("files", ("Source.docx", _docx(*original, "Source-specific terms"), office.MIME)),
            ("files", ("Matching.docx", _docx(*matching_with_distinct_wording), office.MIME)),
            ("files", ("Second match.docx", _docx(*original, "Different target details"), office.MIME)),
            ("files", ("Different.docx", _docx("The tenant must promptly pay the deposit"), office.MIME)),
        ])
        assert upload.status_code == 201, upload.text
        documents = {row["name"]: row for row in upload.json()["documents"]}
        editor = client.post(f"/api/documents/{documents['Source.docx']['id']}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })
        draft = _docx(*edited, "Source-specific terms")
        monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
        saved = client.post(service + "/callback", json={"token": token})
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"error": 0}, saved.text
        result = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
        updated = {row["name"]: row for row in result["document_set"]["documents"]}
        for name, details in (
            ("Matching.docx", "Target-specific terms"),
            ("Second match.docx", "Different target details"),
        ):
            exported = Document(BytesIO(client.get(updated[name]["download_url"]).content))
            assert tuple(p.text for p in exported.tables[0].cell(0, 0).paragraphs) == (*edited, details)
        assert updated["Different.docx"]["version_id"] == documents["Different.docx"]["version_id"]



def test_local_office_syncs_word_soft_breaks_and_appends_before_private_text(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        upload = client.post("/api/document-sets", data={"name": "Line and paragraph endings"}, files=[
            ("files", ("Source.docx", _docx("Common sentence continues"), office.MIME)),
            ("files", ("Matching.docx", _docx("Common sentence continues", "Private detail"), office.MIME)),
            ("files", ("Other.docx", _docx("A different sentence"), office.MIME)),
        ])
        assert upload.status_code == 201, upload.text
        documents = {row["name"]: row for row in upload.json()["documents"]}
        editor = client.post(f"/api/documents/{documents['Source.docx']['id']}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })
        for paragraphs in (
            ("Common sentence\n\ncontinues", "", "New text"),
            ("Common sentence continues", "", "New text"),
        ):
            draft = _docx(*paragraphs)
            monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
            saved = client.post(service + "/callback", json={"token": token})
            assert saved.status_code == 200, saved.text
            result = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
            current = {item["name"]: item for item in result["document_set"]["documents"]}
            assert current["Other.docx"]["version_id"] == documents["Other.docx"]["version_id"]
            exported = Document(BytesIO(client.get(current["Matching.docx"]["download_url"]).content))
            cell = exported.tables[0].cell(0, 0)
            assert tuple(p.text for p in cell.paragraphs) == (*paragraphs, "Private detail")
            assert len(cell.paragraphs[0]._p.xpath(".//w:br")) == paragraphs[0].count("\n")



def test_local_office_continues_target_numbered_and_bulleted_lists(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    def document(numbered, bullets, *, numbering_ids=None, details="Source details"):
        doc = Document()
        numbering = doc.part.numbering_part.element
        for texts, style, base_id in (
            (numbered, "List Number", 5),
            (bullets, "List Bullet", 1),
        ):
            num_id = numbering_ids[base_id] if numbering_ids is not None else base_id
            if num_id != base_id:
                instance = deepcopy(numbering.num_having_numId(base_id))
                instance.set(qn("w:numId"), str(num_id))
                numbering.append(instance)
            for text in texts:
                paragraph = doc.add_paragraph(text, style=style if numbering_ids is None else None)
                if numbering_ids is not None:
                    props = paragraph._p.get_or_add_pPr().get_or_add_numPr()
                    props.get_or_add_ilvl().val = 0
                    props.get_or_add_numId().val = num_id
            if base_id == 5:
                doc.add_paragraph("End of numbered section")
        doc.add_paragraph(details)
        output = BytesIO()
        doc.save(output)
        return output.getvalue()

    number_start = ("First numbered item", "Last numbered item")
    bullet_start = ("First bullet",)
    source_ids, target_ids = {5: 5, 1: 1}, {5: 42, 1: 43}
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        upload = client.post("/api/document-sets", data={"name": "Common lists"}, files=[
            ("files", ("Source.docx", document(number_start, bullet_start, numbering_ids=source_ids), office.MIME)),
            ("files", ("Direct.docx", document(number_start, bullet_start, numbering_ids=target_ids,
                                                   details="Direct details"), office.MIME)),
            ("files", ("Styled.docx", document(number_start, bullet_start, details="Styled details"), office.MIME)),
            ("files", ("Local clause.docx", document(("Local opening item", number_start[1]), bullet_start,
                                                     numbering_ids=target_ids, details="Local details"), office.MIME)),
        ])
        assert upload.status_code == 201, upload.text
        documents = {row["name"]: row for row in upload.json()["documents"]}
        editor = client.post(f"/api/documents/{documents['Source.docx']['id']}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })

        for numbered, bullets in (
            (("First numbered item", "Inserted numbered item", "Last numbered item"),
             ("First bullet", "")),
            (("First numbered item", "Inserted numbered item", "Last numbered item", "Another numbered item"),
             ("First bullet", "Inserted bullet", "Another bullet")),
        ):
            draft = document(numbered, bullets, numbering_ids=source_ids)
            monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
            response = client.post(service + "/callback", json={"token": token})
            assert response.status_code == 200, response.text
            result = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
            assert result["skipped_documents"] == []
            current = {item["name"]: item for item in result["document_set"]["documents"]}
            for name, ids, details in (
                ("Direct.docx", target_ids, "Direct details"),
                ("Styled.docx", source_ids, "Styled details"),
                ("Local clause.docx", target_ids, "Local details"),
            ):
                content = client.get(current[name]["download_url"]).content
                doc = Document(BytesIO(content))
                expected_numbered = ("Local opening item", *numbered[1:]) if name == "Local clause.docx" else numbered
                assert [p.text for p in doc.paragraphs] == [*expected_numbered, "End of numbered section", *bullets, details]
                inventory = importlib.import_module("app.text_inventory_service").build_text_inventory(
                    content, document_id="test", version_id="test", include_empty_paragraphs=True,
                    include_paragraph_lists=True,
                )
                body = [segment for segment in inventory.segments if segment.location["kind"] == "body"]
                expected = [
                    *[(str(ids[5]), "0", False)] * len(numbered), None,
                    *[(str(ids[1]), "0", True)] * len(bullets), None,
                ]
                assert [
                    (segment.numbering.num_id, segment.numbering.level, segment.numbering.is_bullet)
                    if segment.numbering is not None else None
                    for segment in body
                ] == expected
                inserted = doc.paragraphs[1]._p.pPr.numPr
                assert inserted.ilvl.val == 0 and inserted.numId.val == ids[5]



def test_local_office_deletes_only_complete_matching_tables(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    deleted = ("Obsolete shared heading", "Obsolete shared amount")
    surviving = ("Current heading", "Original current amount")
    updated = (surviving[0], "Updated current amount")

    def document(*tables, closing="Private source wording"):
        doc = Document()
        for cells in tables:
            table = doc.add_table(rows=1, cols=len(cells))
            for cell, text in zip(table.rows[0].cells, cells, strict=True):
                cell.text = text
        doc.add_paragraph(closing)
        output = BytesIO()
        doc.save(output)
        return output.getvalue()

    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        files = {
            "Source.docx": document(deleted, surviving),
            "Match.docx": document(deleted, surviving, closing="Private target wording"),
            "Similar.docx": document((deleted[0], "A private amount"), surviving),
            "Different shape.docx": document((" ".join(deleted),), surviving),
            "Ambiguous.docx": document(deleted, deleted, surviving),
        }
        upload = client.post("/api/document-sets", data={"name": "Delete whole shared table"}, files=[
            ("files", (name, content, office.MIME)) for name, content in files.items()
        ])
        assert upload.status_code == 201, upload.text
        documents = {row["name"]: row for row in upload.json()["documents"]}
        editor = client.post(f"/api/documents/{documents['Source.docx']['id']}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })
        draft = document(updated)
        monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
        response = client.post(service + "/callback", json={"token": token})
        assert response.status_code == 200, response.text
        saved = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
        current = {row["name"]: row for row in saved["document_set"]["documents"]}
        assert {item["document_name"]: item["reasons"] for item in saved["skipped_documents"]} == {
            "Ambiguous.docx": ["ambiguous"],
        }
        expected = {
            "Source.docx": [updated],
            "Match.docx": [updated],
            "Similar.docx": [(deleted[0], "A private amount"), updated],
            "Different shape.docx": [(" ".join(deleted),), updated],
            "Ambiguous.docx": [deleted, deleted, updated],
        }
        for name, tables in expected.items():
            content = client.get(current[name]["download_url"]).content
            doc = Document(BytesIO(content))
            assert [tuple(cell.text for cell in table.rows[0].cells) for table in doc.tables] == tables
            closing = "Private target wording" if name == "Match.docx" else "Private source wording"
            assert [p.text for p in doc.paragraphs] == [closing]

        assert client.post(service + "/callback", json={"token": token}).json() == {"error": 0}
        assert client.get(f"/api/onlyoffice/{editor['version_id']}/save-status", params={
            "after_operation": saved["operation_id"],
        }).json() == {"save": None}



def test_local_office_asks_before_deleting_table_with_file_specific_text(tmp_path, monkeypatch):
    workspace = tmp_path / ("nested-release-workspace-" + "x" * 65)
    app = _load_test_app(workspace, monkeypatch)
    office = importlib.import_module("app.local_office")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_URL", "http://127.0.0.1:8080")
    monkeypatch.setenv("DOCSYNC_ONLYOFFICE_SECRET", "local-document-server-test-secret")

    def document(local_row, *, after="Before shared edit"):
        doc = Document()
        if local_row is not None:
            table = doc.add_table(rows=3, cols=1)
            for row, text in zip(table.rows, ("Shared title", "Shared subtitle", local_row), strict=True):
                row.cells[0].text = text
            paragraph = table.cell(0, 0).paragraphs[0]
            for tag in ("bookmarkStart", "bookmarkEnd"):
                mark = OxmlElement("w:" + tag)
                mark.set(qn("w:id"), "12")
                if tag == "bookmarkStart":
                    mark.set(qn("w:name"), "CoverTitle")
                paragraph._p.append(mark)
            paragraph.runs[0]._r.append(OxmlElement("w:softHyphen"))
        doc.add_paragraph(after)
        output = BytesIO()
        doc.save(output)
        return output.getvalue()

    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        originals = {
            "Source.docx": document("Source detail"),
            "Exact.docx": document("Source detail"),
            "Approved.docx": document("Approved local detail"),
            "Kept.docx": document("Kept local detail"),
        }
        upload = client.post("/api/document-sets", data={"name": "Review different cover tables"}, files=[
            ("files", (name, content, office.MIME)) for name, content in originals.items()
        ])
        assert upload.status_code == 201, upload.text
        docs = {row["name"]: row for row in upload.json()["documents"]}
        doc_id = docs["Source.docx"]["id"]
        editor = client.post(f"/api/documents/{doc_id}/onlyoffice/open").json()
        service = urlsplit(editor["embed_url"]).path.replace("onlyoffice-bridge", "onlyoffice-service")
        token = office._sign({
            "operation": "callback", "status": 6, "key": service.rsplit("/", 1)[-1],
            "url": "http://127.0.0.1:8080/edited.docx",
        })
        draft = document(None, after="After shared edit")
        monkeypatch.setattr(office, "_download_draft", lambda *_: draft)
        response = client.post(service + "/callback", json={"token": token})
        assert response.status_code == 200, response.text
        saved = client.get(f"/api/onlyoffice/{editor['version_id']}/save-status").json()["save"]
        history_url = f"/api/documents/{doc_id}/onlyoffice/table-reviews"
        review = saved["table_review"]
        assert [item["document_name"] for item in review] == ["Approved.docx", "Kept.docx"]
        assert all(item["tables"] == [{"index": 0, "table_number": 1, "different_row": 3}] for item in review)
        assert client.get(history_url).json() == [{"operation_id": saved["operation_id"], "files": review}]
        current = {row["name"]: row for row in saved["document_set"]["documents"]}

        def read_doc(file):
            return Document(BytesIO(client.get(file["download_url"]).content))

        assert not read_doc(current["Exact.docx"]).tables
        for name in ("Approved.docx", "Kept.docx"):
            assert read_doc(current[name]).tables[0].cell(2, 0).text == name.split(".")[0] + " local detail"
            assert read_doc(current[name]).paragraphs[0].text == "After shared edit"
            assert current[name]["version_id"] != docs[name]["version_id"]

        review_url = f"/api/onlyoffice/table-reviews/{saved['operation_id']}"
        rejected = client.post(review_url, json={"delete_document_ids": [docs["Exact.docx"]["id"]]})
        assert rejected.status_code == 422
        approved = client.post(review_url, json={"delete_document_ids": [docs["Approved.docx"]["id"]]})
        assert approved.status_code == 200, approved.text
        result = approved.json()
        assert [version["document_id"] for version in result["versions"]] == [docs["Approved.docx"]["id"]]
        new = {row["name"]: row for row in result["document_set"]["documents"]}
        assert not read_doc(new["Approved.docx"]).tables
        assert client.get(result["download_url"]).status_code == 200
        assert new["Kept.docx"]["version_id"] == current["Kept.docx"]["version_id"]
        assert new["Source.docx"]["version_id"] == current["Source.docx"]["version_id"]
        assert client.get(history_url).json() == []
        assert client.post(review_url, json={"delete_document_ids": [docs["Approved.docx"]["id"]]}).status_code == 404
