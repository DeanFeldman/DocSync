from __future__ import annotations

from collections import defaultdict
import logging
from time import perf_counter

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .editor_service import document_version_path
from .models import (
    DocumentBlockRevision,
    DocumentHead,
    DocumentRecord,
    DocumentVersion,
)
from .schemas import TextSearchRequest
from .text_inventory_service import (
    DocumentTextInventory,
    DocumentTextSegment,
    build_text_inventory,
    find_occurrence_ranges,
    normalise_search_text,
    occurrence_context,
    occurrence_id,
)


logger = logging.getLogger(__name__)


def _binding_key(location: dict | None) -> tuple:
    value = dict(location or {})
    kind = value.get("kind")
    if kind == "body":
        return ("body", int(value.get("paragraph_index", -1)))
    if kind in {"table_paragraph", "table_cell"}:
        return (
            "table_paragraph",
            int(value.get("table_index", -1)),
            int(value.get("row_index", -1)),
            int(value.get("column_index", -1)),
            int(value.get("paragraph_index", 0)),
        )
    if kind in {"header_paragraph", "footer_paragraph"}:
        return (
            kind,
            str(value.get("part_relationship_id") or ""),
            int(value.get("paragraph_index", -1)),
        )
    return (str(kind or ""),)


def bind_inventory_to_revisions(
    session: Session,
    inventory: DocumentTextInventory,
) -> None:
    revisions = list(
        session.scalars(
            select(DocumentBlockRevision).where(
                DocumentBlockRevision.version_id == inventory.version_id
            )
        )
    )
    revisions_by_location = {
        _binding_key(revision.location_json): revision for revision in revisions
    }
    for segment in inventory.segments:
        if int(segment.location.get("nested_table_depth", 0) or 0) > 0:
            continue
        revision = revisions_by_location.get(_binding_key(segment.location))
        if revision is not None:
            segment.element_id = revision.element_id
            segment.revision_id = revision.id


def _fts_candidate_documents(
    session: Session,
    document_set_id: str,
    normalized_query: str,
) -> tuple[set[str], str]:
    if (
        len(normalized_query) < 3
        or session.bind is None
        or session.bind.dialect.name != "sqlite"
    ):
        return set(), "complete_inventory_scan"
    try:
        exists = bool(
            session.scalar(
                text(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                    "AND name = 'document_block_fts'"
                )
            )
        )
        if not exists:
            return set(), "complete_inventory_scan"
        phrase = f'"{normalized_query.replace(chr(34), chr(34) * 2)}"'
        rows = session.execute(
            text(
                "SELECT DISTINCT r.document_id "
                "FROM document_block_fts f "
                "JOIN document_block_revisions r ON r.id = f.revision_id "
                "JOIN document_heads h ON h.current_version_id = r.version_id "
                "JOIN documents d ON d.id = r.document_id "
                "WHERE d.document_set_id = :document_set_id "
                "AND document_block_fts MATCH :query"
            ),
            {"document_set_id": document_set_id, "query": phrase},
        )
        return {str(row[0]) for row in rows}, "fts5_ordered_complete_inventory_scan"
    except OperationalError:
        logger.warning(
            "docsync.find_replace_fts_unavailable document_set_id=%s",
            document_set_id,
            exc_info=True,
        )
        return set(), "complete_inventory_scan"


def _include_segment(segment: DocumentTextSegment, request: TextSearchRequest) -> bool:
    if segment.structure_type == "comment":
        return request.include_comments
    if segment.structure_type == "tracked_delete":
        return request.include_historical_tracked_text
    if segment.structure_type == "field_instruction":
        return request.include_field_instructions
    return segment.searchable_by_default


def _location_label(segment: DocumentTextSegment) -> str:
    location = segment.location
    structure = segment.structure_type.replace("_", " ")
    if segment.structure_type == "table_paragraph":
        nested = int(location.get("nested_table_depth", 0) or 0)
        prefix = "Nested table" if nested else "Table"
        return (
            f"{prefix} {int(location.get('table_index', 0)) + 1}, row "
            f"{int(location.get('row_index', 0)) + 1}, column "
            f"{int(location.get('column_index', 0)) + 1}, paragraph "
            f"{int(location.get('paragraph_index', 0)) + 1}"
        )
    if segment.structure_type in {"header_paragraph", "footer_paragraph"}:
        return (
            f"{structure.title()}, section "
            f"{int(location.get('source_section_index', 0)) + 1}, paragraph "
            f"{int(location.get('paragraph_index', 0)) + 1}"
        )
    identifier = location.get("footnote_id") or location.get("endnote_id") or location.get("comment_id")
    if identifier is not None:
        return f"{structure.title()} {identifier}"
    return f"{structure.title()}, paragraph {int(location.get('paragraph_index', 0)) + 1}"


def _serialize_occurrence(
    segment: DocumentTextSegment,
    document: DocumentRecord,
    start: int,
    end: int,
    index: int,
) -> dict:
    editable, reason = segment.editability_for_range(start, end)
    before, matched, after = occurrence_context(segment.text, start, end)
    effective_type = segment.effective_structure_type(start, end)
    value = occurrence_id(segment, start, end)
    return {
        "occurrence_id": value,
        "result_id": value,
        "segment_id": segment.segment_id,
        "element_id": segment.element_id or segment.segment_id,
        "revision_id": segment.revision_id,
        "document_id": document.id,
        "document_name": document.original_name,
        "version_id": segment.version_id,
        "part": segment.part_path,
        "part_path": segment.part_path,
        "structure_type": effective_type,
        "segment_structure_type": segment.structure_type,
        "element_type": effective_type,
        "location": segment.location,
        **segment.location,
        "location_label": _location_label(segment),
        "paragraph_index": int(segment.location.get("paragraph_index", 0) or 0),
        "text": segment.text,
        "occurrence_index": index,
        "match_start": start,
        "match_end": end,
        "context_before": before,
        "matched_text": matched,
        "context_after": after,
        "editable": editable,
        "read_only": not editable,
        "read_only_reason": reason,
        "protected_ranges": segment.protected_ranges,
    }


def search_document_text_inventory(
    session: Session,
    document_set_id: str,
    request: TextSearchRequest,
) -> dict:
    total_started = perf_counter()
    rows = session.execute(
        select(DocumentRecord, DocumentHead, DocumentVersion)
        .join(DocumentHead, DocumentHead.document_id == DocumentRecord.id)
        .join(DocumentVersion, DocumentVersion.id == DocumentHead.current_version_id)
        .where(DocumentRecord.document_set_id == document_set_id)
        .order_by(DocumentRecord.original_name)
    ).all()
    if not rows:
        exists = session.scalar(
            select(DocumentRecord.id).where(
                DocumentRecord.document_set_id == document_set_id
            )
        )
        if exists is None:
            from .models import DocumentSet

            if session.get(DocumentSet, document_set_id) is None:
                raise HTTPException(status_code=404, detail="Document set not found.")

    requested_ids = set(request.document_ids or [])
    available_ids = {document.id for document, _head, _version in rows}
    if requested_ids - available_ids:
        raise HTTPException(
            status_code=422,
            detail="Every scoped document must belong to this document set.",
        )
    if requested_ids:
        rows = [row for row in rows if row[0].id in requested_ids]

    normalized_query = normalise_search_text(request.query, match_case=request.match_case)
    candidate_started = perf_counter()
    fts_candidates, engine = _fts_candidate_documents(
        session,
        document_set_id,
        normalized_query,
    )
    candidate_ms = (perf_counter() - candidate_started) * 1000
    rows.sort(
        key=lambda row: (
            0 if row[0].id in fts_candidates else 1,
            row[0].original_name.casefold(),
        )
    )

    scan_started = perf_counter()
    all_results: list[dict] = []
    counts: dict[str, dict] = {}
    editable_count = 0
    read_only_count = 0
    segment_count = 0
    for document, _head, version in rows:
        inventory = build_text_inventory(
            document_version_path(version),
            document_id=document.id,
            version_id=version.id,
        )
        bind_inventory_to_revisions(session, inventory)
        segment_count += len(inventory.segments)
        document_occurrence_index = 0
        for segment in inventory.segments:
            if not _include_segment(segment, request):
                continue
            for start, end in find_occurrence_ranges(
                segment.text,
                request.query,
                match_case=request.match_case,
                whole_word=request.whole_word,
            ):
                document_occurrence_index += 1
                item = _serialize_occurrence(
                    segment,
                    document,
                    start,
                    end,
                    document_occurrence_index,
                )
                all_results.append(item)
                if item["editable"]:
                    editable_count += 1
                else:
                    read_only_count += 1
                summary = counts.setdefault(
                    document.id,
                    {
                        "document_id": document.id,
                        "document_name": document.original_name,
                        "result_count": 0,
                        "editable_count": 0,
                        "read_only_count": 0,
                    },
                )
                summary["result_count"] += 1
                summary["editable_count" if item["editable"] else "read_only_count"] += 1
    scan_ms = (perf_counter() - scan_started) * 1000
    result_count = len(all_results)
    results = all_results if request.limit is None else all_results[: request.limit]
    total_ms = (perf_counter() - total_started) * 1000
    logger.info(
        "docsync.find_replace_timing document_set_id=%s engine=%s documents=%s "
        "segments=%s results=%s candidate_ms=%.2f scan_ms=%.2f total_ms=%.2f",
        document_set_id,
        engine,
        len(rows),
        segment_count,
        result_count,
        candidate_ms,
        scan_ms,
        total_ms,
    )
    return {
        "query": request.query,
        "options": {
            "match_case": request.match_case,
            "whole_word": request.whole_word,
            "include_comments": request.include_comments,
            "include_historical_tracked_text": request.include_historical_tracked_text,
            "include_field_instructions": request.include_field_instructions,
        },
        "results": results,
        "result_count": result_count,
        "returned_count": len(results),
        "editable_count": editable_count,
        "read_only_count": read_only_count,
        "document_count": len(counts),
        "document_counts": list(counts.values()),
        "truncated": len(results) < result_count,
        "candidate_engine": engine,
        "candidate_document_count": len(fts_candidates),
        "scanned_document_count": len(rows),
        "scanned_segment_count": segment_count,
        "timings": {
            "candidate_retrieval_ms": round(candidate_ms, 2),
            "exact_occurrence_scan_ms": round(scan_ms, 2),
            "total_result_build_ms": round(total_ms, 2),
        },
    }
