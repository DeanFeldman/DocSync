from io import BytesIO
from zipfile import ZipFile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.shared import Inches, Pt
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
    heading = doc.add_heading("Agreement", level=1)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    heading.paragraph_format.space_after = Pt(18)
    doc.sections[0].left_margin = Inches(1.15)
    doc.sections[0].header.paragraphs[0].text = "Agreement header"
    table = doc.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.cell(0, 0).text = "Definition"
    inner = table.cell(0, 1).add_table(rows=1, cols=1)
    inner.style = "Light Shading"
    paragraph = inner.cell(0, 0).paragraphs[0]
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
        footer = doc.sections[0].footer.add_paragraph()
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
            target = next(block for block in blocks if block["text"] == "See clause 1.1 above.")
            assert target["element_type"] == "table_paragraph"
            assert target["supported"] and not target["read_only"]
            working = client.get(f"{endpoint}/download").content
            with ZipFile(BytesIO(payload)) as original, ZipFile(BytesIO(working)) as converted:
                assert converted.namelist() == original.namelist()
                for name in original.namelist():
                    if name not in {"word/document.xml", "word/footer1.xml"}:
                        assert original.read(name) == converted.read(name), name
            parsed = Document(BytesIO(working))
            heading = parsed.paragraphs[0]
            assert heading.style.name == "Heading 1"
            assert heading.alignment == WD_ALIGN_PARAGRAPH.CENTER
            assert heading.paragraph_format.space_after == Pt(18)
            assert parsed.sections[0].left_margin == Inches(1.15)
            assert parsed.sections[0].header.paragraphs[0].text == "Agreement header"
            assert parsed.tables[0].style.name == "Table Grid"
            assert parsed.tables[0].cell(0, 0).text == "Definition"
            nested = parsed.tables[0].cell(0, 1).tables[0]
            assert nested.style.name == "Light Shading"
            converted_cell = nested.cell(0, 0).paragraphs[0]
            assert converted_cell.text == "See clause 1.1 above."
            assert next(run for run in converted_cell.runs if run.text == "1.1").bold
            assert not converted_cell._p.xpath(".//w:fldChar | .//w:instrText")
            assert [item.style.name for item in parsed.paragraphs[1:]] == ["List Number", "List Number"]
            assert parsed.element.xpath(".//w:sdt")
            first, page_number, _ = parsed.sections[0].footer.paragraphs
            assert first.text == "7"
            assert not first._p.xpath(".//w:fldSimple")
            assert page_number._p.xpath(".//w:fldSimple")[0].get(qn("w:instr")) == "PAGE"

        document = current[0]
        editor_url = f"/api/document-versions/{document['version_id']}/editor-content"
        source = next(
            block for block in client.get(editor_url).json()["blocks"]
            if block["text"] == "See clause 1.1 above."
        )
        edit = {
            "base_versions": {document["id"]: document["version_id"]},
            "source_element_id": source["element_id"],
            "edit_mode": "override",
            "targets": [{
                "element_id": source["element_id"],
                "replacement_text": "See clause 9.4 above.",
                "delta": {"ops": [
                    {**operation, "insert": operation["insert"].replace("1.1", "9.4")}
                    for operation in source["delta"]["ops"]
                ]},
            }],
        }
        set_url = f"/api/document-sets/{workspace['id']}"
        preview = client.post(f"{set_url}/editor-preview", json=edit)
        assert preview.status_code == 200, preview.text
        generated = client.post(f"{set_url}/editor-generate", json=edit)
        assert generated.status_code == 201, generated.text
        version_id = generated.json()["versions"][0]["version_id"]
        downloaded = client.get(f"/api/document-versions/{version_id}/download")
        edited = Document(BytesIO(downloaded.content))
        nested = edited.tables[0].cell(0, 1).tables[0]
        assert nested.style.name == "Light Shading"
        edited_cell = nested.cell(0, 0).paragraphs[0]
        assert edited_cell.text == "See clause 9.4 above."
        assert next(run for run in edited_cell.runs if run.text == "9.4").bold
        assert edited.tables[0].cell(0, 0).text == "Definition"
        assert edited.tables[0].style.name == "Table Grid"
        assert edited.paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.CENTER
        assert edited.sections[0].header.paragraphs[0].text == "Agreement header"
        assert client.get(f"/api/document-versions/{document['id']}/download").content == payload



def test_word_smart_tags_keep_visible_words_editable(tmp_path, monkeypatch):
    app = _load_test_app(tmp_path, monkeypatch)
    doc = Document()
    paragraph = doc.add_paragraph("DWELLING ")
    tagged = OxmlElement("w:smartTag")
    tagged.append(paragraph.add_run("UNIT")._r)
    paragraph._p.append(tagged)
    paragraph.add_run(": the property.")
    output = BytesIO()
    doc.save(output)
    payload = output.getvalue()

    with TestClient(app) as client:
        response = client.post(
            "/api/document-sets",
            data={"name": "Smart tags"},
            files=[("files", ("First.docx", payload, MIME)), ("files", ("Second.docx", payload, MIME))],
        )
        assert response.is_success, response.text
        workspace = response.json()
        document = workspace["documents"][0]
        current = document["version_id"]
        endpoint = f"/api/document-versions/{current}"
        source = client.get(f"{endpoint}/editor-content").json()["blocks"][0]
        assert source["text"] == "DWELLING UNIT: the property."
        assert source["supported"]
        assert client.get(f"{endpoint}/download").content == payload
        edited = client.post(f"/api/document-sets/{workspace['id']}/editor-generate", json={
            "base_versions": {document["id"]: current},
            "edit_mode": "override",
            "source_element_id": source["element_id"],
            "targets": [{"element_id": source["element_id"], "replacement_text": "DWELLING UNIT: the home."}],
        })
        assert edited.is_success, edited.text
        version_id = edited.json()["versions"][0]["version_id"]
        result = client.get(f"/api/document-versions/{version_id}/download")
        assert Document(BytesIO(result.content)).paragraphs[0].text == "DWELLING UNIT: the home."
