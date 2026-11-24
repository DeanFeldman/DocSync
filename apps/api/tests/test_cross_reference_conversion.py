from io import BytesIO

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from fastapi.testclient import TestClient

from test_batch_editing import _load_test_app


MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def marker(paragraph, kind: str):
    field = OxmlElement("w:fldChar")
    field.set(qn("w:fldCharType"), kind)
    paragraph.add_run()._r.append(field)


def package() -> bytes:
    doc = Document()
    paragraph = doc.add_table(rows=1, cols=1).cell(0, 0).paragraphs[0]
    paragraph.add_run("See clause ")
    marker(paragraph, "begin")
    for part in (" RE", "F bookmark "):
        instruction = OxmlElement("w:instrText")
        instruction.text = part
        paragraph.add_run()._r.append(instruction)
    marker(paragraph, "separate")
    paragraph.add_run("1.1").bold = True
    marker(paragraph, "end")
    paragraph.add_run(" above.")

    doc.add_paragraph("First item", style="List Number")
    doc.add_paragraph("Second item", style="List Number")
    control = OxmlElement("w:sdt")
    control_contents = OxmlElement("w:sdtContent")
    control_contents.append(doc.add_paragraph("Control value 123")._p)
    control.append(control_contents)
    doc.element.body.insert_element_before(control, "w:sectPr")
    footer = doc.sections[0].footer.paragraphs[0]
    for code, result in (("PAGEREF bookmark", "7"), ("PAGE", "2")):
        field = OxmlElement("w:fldSimple")
        field.set(qn("w:instr"), code)
        field.append(footer.add_run(result)._r)
        footer._p.append(field)
    output = BytesIO()
    doc.save(output)
    return output.getvalue()


def test_import_makes_plain_working_versions_and_preserves_originals(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    payload = package()
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/document-sets",
            data={"name": "Reference conversion"},
            files=[("files", ("First.docx", payload, MIME)), ("files", ("Second.docx", payload, MIME))],
        )
        assert uploaded.status_code == 201, uploaded.text
        workspace = uploaded.json()
        added = client.post(
            f"/api/document-sets/{workspace['id']}/documents",
            files=[("files", ("Third.docx", payload, MIME))],
        )
        assert added.is_success, added.text
        current = added.json()["documents"]
        assert len(current) == 3
        for document in current:
            version_id = document["version_id"]
            assert document["version_number"] == 2
            assert client.get(f"/api/document-versions/{document['id']}/download").content == payload
            endpoint = f"/api/document-versions/{version_id}"
            blocks = client.get(f"{endpoint}/editor-content").json()["blocks"]
            expected = [
                "See clause 1.1 above.", "1. First item", "2. Second item",
                "Control value 123", "72",
            ]
            assert [block["text"] for block in blocks] == expected
            assert all(block["supported"] and not block["read_only"] for block in blocks)
            parsed = Document(BytesIO(client.get(f"{endpoint}/download").content))
            assert [paragraph.text for paragraph in parsed.paragraphs] == expected
            assert not parsed.element.xpath(".//w:fldChar | .//w:fldSimple | .//w:sdt")
            assert not parsed.element.xpath(".//w:numPr | .//w:hyperlink")
            assert not parsed.tables
            assert not parsed.sections[0].footer.paragraphs[0].text

        document = current[0]
        editor_url = f"/api/document-versions/{document['version_id']}/editor-content"
        source = client.get(editor_url).json()["blocks"][0]
        edit = {
            "base_versions": {document["id"]: document["version_id"]},
            "source_element_id": source["element_id"],
            "edit_mode": "override",
            "targets": [{
                "element_id": source["element_id"],
                "replacement_text": "See clause 9.4 instead.",
            }],
        }
        set_url = f"/api/document-sets/{workspace['id']}"
        preview = client.post(f"{set_url}/editor-preview", json=edit)
        assert preview.status_code == 200, preview.text
        generated = client.post(f"{set_url}/editor-generate", json=edit)
        assert generated.status_code == 201, generated.text
        version_id = generated.json()["versions"][0]["version_id"]
        downloaded = client.get(f"/api/document-versions/{version_id}/download")
        assert Document(BytesIO(downloaded.content)).paragraphs[0].text == "See clause 9.4 instead."
        assert client.get(f"/api/document-versions/{document['id']}/download").content == payload
