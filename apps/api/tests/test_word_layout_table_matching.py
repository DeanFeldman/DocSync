from pathlib import Path

import pymupdf

from test_inline_preview_jobs import load_test_app


def test_word_order_keeps_table_cells_and_cross_page_paragraph_selectable(
    tmp_path: Path, monkeypatch
) -> None:
    load_test_app(tmp_path, monkeypatch)
    from app.render_map_service import _extract_pdf_structure, _match_blocks, _regions_for_match, _RenderContext

    pdf_path = tmp_path / "word-order.pdf"
    with pymupdf.open() as pdf:
        for _ in range(8):
            pdf.new_page()
        first = pdf.new_page(width=612, height=792)
        first.insert_text((75, 710), "Designated bank")
        first.insert_text((75, 728), "account")
        first.insert_text((285, 710), "This definition begins near the foot of one page")
        first.insert_text((285, 728), "and has a second line in the same cell.")
        second = pdf.new_page(width=612, height=792)
        second.insert_text((525, 36), "1 0")
        second.insert_text((285, 75), "It continues on the next page.")
        pdf.save(pdf_path)

    texts = (
        "Designated bank account",
        "This definition begins near the foot of one page and has a second line in the same cell. "
        "It continues on the next page.",
    )
    blocks = tuple(
        {
            "element_id": str(index), "ordinal": index, "element_type": "table_paragraph",
            "text": text, "supported": True, "unsupported_reason": None,
            "location": {"table_index": 0, "row_index": 0, "column_index": index},
        }
        for index, text in enumerate(texts)
    )
    stat = pdf_path.stat()
    context = _RenderContext(
        version_id="test-version", document_id="test-document", document_set_id="test-set",
        source_path=pdf_path, source_sha256="", pdf_path=pdf_path, pdf_size=stat.st_size,
        pdf_mtime_ns=stat.st_mtime_ns, cache_path=tmp_path / "map.json", blocks=blocks,
    )
    _, tokens, _ = _extract_pdf_structure(context, "a" * 24)
    matches, unmapped = _match_blocks(blocks, tokens)
    assert not unmapped
    for index, pages in enumerate(({9}, {9, 10})):
        regions = _regions_for_match(matches[str(index)], tokens, context)
        assert {item["page_number"] for item in regions} == pages
        assert all(item["interactive"] for item in regions)
