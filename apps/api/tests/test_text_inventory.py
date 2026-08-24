from __future__ import annotations

from io import BytesIO
import hashlib
import importlib
from pathlib import Path
import sys
import zipfile

from docx import Document
from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from app.text_inventory_service import (
    TextReplacementPatch,
    apply_text_replacements,
    build_text_inventory,
    find_occurrence_ranges,
    occurrence_id,
)

from docx_inventory_fixtures import (
    CROSS_RUN_ONLY_PHRASE,
    EXPECTED_DEFAULT_OCCURRENCES,
    EXPECTED_EXHAUSTIVE_OCCURRENCES,
    UNIQUE_PHRASE,
    make_exhaustive_text_inventory_docx,
)


def _phrase_occurrences(inventory, *, include_non_default: bool) -> list:
    result = []
    for segment in inventory.segments:
        if not include_non_default and not segment.searchable_by_default:
            continue
        for start, end in find_occurrence_ranges(segment.text, UNIQUE_PHRASE):
            result.append((segment, start, end))
    return result


def _load_test_app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DOCUMENTSYNC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(
        "DOCUMENTSYNC_DATABASE_URL",
        f"sqlite:///{tmp_path / 'text-inventory.db'}",
    )
    monkeypatch.setenv("DOCUMENTSYNC_SESSION_TOKEN", "")
    monkeypatch.delenv("DOCUMENTSYNC_WEB_DIST", raising=False)
    for module_name in list(sys.modules):
        if module_name == "app" or module_name.startswith("app."):
            del sys.modules[module_name]
    return importlib.import_module("app.main").app


def test_inventory_discovers_the_exact_known_occurrence_count_across_word_structures():
    payload = make_exhaustive_text_inventory_docx()
    inventory = build_text_inventory(
        payload,
        document_id="document",
        version_id="version",
    )

    exhaustive = _phrase_occurrences(inventory, include_non_default=True)
    ordinary = _phrase_occurrences(inventory, include_non_default=False)
    assert len(exhaustive) == EXPECTED_EXHAUSTIVE_OCCURRENCES
    assert len(ordinary) == EXPECTED_DEFAULT_OCCURRENCES

    structure_types = {segment.structure_type for segment, _start, _end in exhaustive}
    assert {
        "body_paragraph",
        "heading",
        "list_item",
        "table_paragraph",
        "header_paragraph",
        "footer_paragraph",
        "footnote",
        "endnote",
        "comment",
        "content_control",
        "text_box",
        "tracked_delete",
        "drawing_text",
    } <= structure_types

    split = next(
        segment
        for segment in inventory.segments
        if segment.text == UNIQUE_PHRASE and len(segment.spans) >= 4
    )
    assert find_occurrence_ranges(split.text, "UNIQUE_SEARCH") == [(8, 21)]


def test_inventory_reports_protected_text_instead_of_silently_omitting_it():
    inventory = build_text_inventory(
        make_exhaustive_text_inventory_docx(),
        document_id="document",
        version_id="version",
    )
    occurrences = _phrase_occurrences(inventory, include_non_default=True)
    read_only = [
        (segment, start, end, segment.editability_for_range(start, end)[1])
        for segment, start, end in occurrences
        if not segment.editability_for_range(start, end)[0]
    ]
    reasons = {reason for _segment, _start, _end, reason in read_only}
    assert len(read_only) == 2
    assert any("tracked deletion" in (reason or "") for reason in reasons)
    assert any("DrawingML" in (reason or "") for reason in reasons)


def test_cross_run_hyperlink_nested_table_notes_content_control_and_text_box_round_trip():
    payload = make_exhaustive_text_inventory_docx()
    inventory = build_text_inventory(
        payload,
        document_id="document",
        version_id="version",
    )
    wanted_types = {
        "mixed_runs",
        "body_paragraph",
        "hyperlink",
        "table_paragraph",
        "header_paragraph",
        "footer_paragraph",
        "footnote",
        "endnote",
        "content_control",
        "text_box",
        "tracked_insert",
    }
    selected = {}
    for segment, start, end in _phrase_occurrences(
        inventory,
        include_non_default=False,
    ):
        effective = segment.effective_structure_type(start, end)
        editable, _reason = segment.editability_for_range(start, end)
        if (
            editable
            and segment.text == UNIQUE_PHRASE
            and len(segment.spans) >= 4
            and "mixed_runs" not in selected
        ):
            selected["mixed_runs"] = (segment, start, end)
        if (
            effective == "table_paragraph"
            and not segment.location.get("nested_table_depth")
        ):
            continue
        if editable and effective in wanted_types and effective not in selected:
            selected[effective] = (segment, start, end)
    assert wanted_types <= selected.keys()

    patches = [
        TextReplacementPatch(
            occurrence_id=occurrence_id(segment, start, end),
            segment_id=segment.segment_id,
            part_path=segment.part_path,
            match_start=start,
            match_end=end,
            expected_text=segment.text[start:end],
            replacement_text=f"REPLACED_{structure_type.upper()}",
        )
        for structure_type, (segment, start, end) in selected.items()
    ]

    with zipfile.ZipFile(BytesIO(payload)) as archive:
        before_untouched = {
            name: hashlib.sha256(archive.read(name)).hexdigest()
            for name in ("word/styles.xml", "word/numbering.xml")
        }
        relationships_before = archive.read("word/_rels/document.xml.rels")

    updated = apply_text_replacements(payload, inventory, patches)
    Document(BytesIO(updated))
    rescanned = build_text_inventory(
        updated,
        document_id="document",
        version_id="result-version",
    )
    remaining = _phrase_occurrences(rescanned, include_non_default=True)
    assert len(remaining) == EXPECTED_EXHAUSTIVE_OCCURRENCES - len(patches)
    all_text = "\n".join(segment.text for segment in rescanned.segments)
    for structure_type in selected:
        assert f"REPLACED_{structure_type.upper()}" in all_text

    with zipfile.ZipFile(BytesIO(updated)) as archive:
        assert {
            name: hashlib.sha256(archive.read(name)).hexdigest()
            for name in before_untouched
        } == before_untouched
        assert archive.read("word/_rels/document.xml.rels") == relationships_before


def test_unicode_case_whitespace_short_terms_and_whole_word_offsets_are_exact():
    text = "Straße STRASSE company company's companies pre-company company-wide café naïve résumé A I 1 % &"
    assert find_occurrence_ranges(text, "strasse") == [(0, 6), (7, 14)]
    assert find_occurrence_ranges(text, "STRASSE", match_case=True) == [(7, 14)]
    assert find_occurrence_ranges(text, "company", whole_word=True) == [
        (15, 22),
        (23, 30),
        (47, 54),
        (55, 62),
    ]
    for query in ("café", "naïve", "résumé", "A", "I", "1", "%", "&"):
        assert find_occurrence_ranges(text, query)


def test_find_replace_api_scans_every_current_package_and_separates_editability(
    tmp_path: Path,
    monkeypatch,
):
    app = _load_test_app(tmp_path, monkeypatch)
    payload = make_exhaustive_text_inventory_docx()
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/document-sets",
            data={"name": "Complete text inventory"},
            files=[
                (
                    "files",
                    ("Alpha.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                ),
                (
                    "files",
                    ("Beta.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                ),
            ],
        )
        assert uploaded.status_code == 201, uploaded.text
        document_set_id = uploaded.json()["id"]

        ordinary = client.post(
            f"/api/document-sets/{document_set_id}/find-replace/search",
            json={"query": UNIQUE_PHRASE},
        )
        assert ordinary.status_code == 200, ordinary.text
        ordinary_payload = ordinary.json()
        assert ordinary_payload["result_count"] == EXPECTED_DEFAULT_OCCURRENCES * 2
        assert ordinary_payload["editable_count"] == (EXPECTED_DEFAULT_OCCURRENCES - 1) * 2
        assert ordinary_payload["read_only_count"] == 2
        assert ordinary_payload["scanned_document_count"] == 2
        assert all("occurrence_id" in result for result in ordinary_payload["results"])

        exhaustive = client.post(
            f"/api/document-sets/{document_set_id}/find-replace/search",
            json={
                "query": UNIQUE_PHRASE,
                "include_comments": True,
                "include_historical_tracked_text": True,
            },
        )
        assert exhaustive.status_code == 200, exhaustive.text
        assert exhaustive.json()["result_count"] == EXPECTED_EXHAUSTIVE_OCCURRENCES * 2

        split_phrase = client.get(
            f"/api/document-sets/{document_set_id}/search",
            params={"q": CROSS_RUN_ONLY_PHRASE},
        )
        assert split_phrase.status_code == 200, split_phrase.text
        assert split_phrase.json()["result_count"] == 2
