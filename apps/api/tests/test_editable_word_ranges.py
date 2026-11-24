from io import BytesIO

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from fastapi.testclient import TestClient

from test_batch_editing import _load_test_app, _occurrence_payload, _wait_for_generation


def test_table_text_edit_preserves_embedded_word_field(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    doc = Document()
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Definition"
    paragraph = table.cell(0, 1).paragraphs[0]
    paragraph.add_run("means the existing party, see ").bold = True
    for kind in ("begin", "instruction", "separate", "result", "end"):
        run = paragraph.add_run("1.1" if kind == "result" else "")
        if kind == "instruction":
            element = OxmlElement("w:instrText")
            element.text = " DOCPROPERTY definition_reference "
        elif kind != "result":
            element = OxmlElement("w:fldChar")
            element.set(qn("w:fldCharType"), kind)
        else:
            continue
        run._r.append(element)
    paragraph.add_run(" for more details.")
    source = BytesIO()
    doc.save(source)
    content = source.getvalue()
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    with TestClient(app) as client:
        uploaded = client.post(
            "/api/document-sets",
            data={"name": "Cross-reference workspace"},
            files=[("files", ("Primary.docx", content, mime)), ("files", ("Related.docx", content, mime))],
        )
        assert uploaded.status_code == 201, uploaded.text
        workspace = uploaded.json()
        primary = next(item for item in workspace["documents"] if item["name"] == "Primary.docx")
        related = next(item for item in workspace["documents"] if item["name"] == "Related.docx")
        restored = client.post(
            f"/api/documents/{primary['id']}/versions/{primary['id']}/restore",
            json={"expected_current_version_id": primary["version_id"]},
        )
        assert restored.status_code == 201, restored.text
        version_id = restored.json()["version"]["version_id"]
        version_url = f"/api/document-versions/{version_id}"
        blocks = client.get(f"{version_url}/editor-content").json()["blocks"]
        block = next(block for block in blocks if "existing party" in block["text"])
        assert not block["supported"]

        ranges_url = f"{version_url}/blocks/{block['element_id']}/text-ranges"
        response = client.get(ranges_url)
        assert response.status_code == 200, response.text
        regions = response.json()["ranges"]
        assert [(item["matched_text"], item["editable"]) for item in regions] == [
            ("means the existing party, see", True),
            ("1.1", False),
            ("for more details.", True),
        ]
        batch = client.post(
            f"/api/document-sets/{workspace['id']}/edit-batches", json={"title": "Change wording"}
        ).json()
        batch_url = f"/api/edit-batches/{batch['id']}"
        for index, replacement in [(0, "means the new party, see"), (2, "for the full definition.")]:
            item = regions[index]
            staged = client.post(f"{batch_url}/operations", json={
                "operation_type": "find_replace",
                "replacement_text": replacement,
                "find_request": {"query": item["matched_text"], "match_case": True},
                "occurrences": [_occurrence_payload(item)],
            })
            assert staged.status_code == 201, staged.text
        protected = regions[1]
        rejected = client.post(f"{batch_url}/operations", json={
            "operation_type": "find_replace",
            "replacement_text": "9.9",
            "find_request": {"query": protected["matched_text"], "match_case": True},
            "occurrences": [_occurrence_payload(protected)],
        })
        assert rejected.status_code == 422, rejected.text
        preview = client.post(f"{batch_url}/preview")
        assert preview.json()["status"] == "ready", preview.text
        assert preview.json()["affected_location_count"] == 2
        generation = client.post(f"{batch_url}/generate")
        assert generation.status_code == 202, generation.text
        complete = _wait_for_generation(client, batch["id"])
        assert complete["status"] == "completed", complete
        assert len(complete["result_version_ids"]) == 1
        result_id = complete["result_version_ids"][0]
        downloaded = client.get(f"/api/document-versions/{result_id}/download")
        assert downloaded.status_code == 200, downloaded.text
        result = Document(BytesIO(downloaded.content))
        updated = result.tables[0].cell(0, 1).paragraphs[0]
        assert updated.text == "means the new party, see 1.1 for the full definition."
        assert updated.runs[0].bold
        assert [node.text for node in updated._p.xpath(".//w:instrText")] == [
            " DOCPROPERTY definition_reference "
        ]
        assert len(updated._p.xpath(".//w:fldChar")) == 3
        assert result.tables[0].cell(0, 0).text == "Definition"
        assert client.get(f"{version_url}/download").content == content
        assert client.get(f"/api/document-versions/{related['id']}/download").content == content
        assert client.get(ranges_url).status_code == 409
