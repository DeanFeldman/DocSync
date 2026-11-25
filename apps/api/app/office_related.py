"""Suggest exact, version-bound text edits from a reviewed ONLYOFFICE save."""

from collections import Counter, defaultdict
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from .editor_service import document_version_path
from .models import DocumentHead, DocumentRecord, DocumentVersion
from .schemas import EditBatchOperationRequest, FindReplaceOccurrenceTarget, TextSearchRequest
from .text_inventory_service import (
    DocumentTextSegment,
    build_text_inventory,
    find_occurrence_ranges,
    occurrence_id,
)


@dataclass(frozen=True)
class RelatedEdit:
    document_name: str
    before: str
    after: str
    replacement: str
    target: FindReplaceOccurrenceTarget

    def preview(self) -> dict:
        return {
            "id": self.target.occurrence_id,
            "document_name": self.document_name,
            "before": self.before,
            "after": self.after,
        }


def _paragraphs(content: bytes, version: DocumentVersion) -> list[DocumentTextSegment]:
    inventory = build_text_inventory(content, document_id=version.document_id, version_id=version.id)
    return [
        segment for segment in inventory.segments
        if segment.location.get("kind") in {"body", "table_paragraph", "header_paragraph", "footer_paragraph"}
        and segment.structure_type not in {"field_instruction", "tracked_delete"}
    ]


def _position(segment: DocumentTextSegment) -> tuple:
    location = segment.location
    cell = tuple((part["table_index"], part["row_index"], part["column_index"])
                 for part in location.get("table_path", []))
    return (segment.part_path, location["kind"], cell, location["paragraph_index"])


def _context(segment: DocumentTextSegment) -> tuple:
    location = segment.location
    return (segment.structure_type, location.get("part_kind"), location.get("header_footer_type"))


def _changed_span(before: str, after: str) -> tuple[int, int, str] | None:
    start = 0
    limit = min(len(before), len(after))
    while start < limit and before[start] == after[start]:
        start += 1
    suffix = 0
    while suffix < limit - start and before[-1 - suffix] == after[-1 - suffix]:
        suffix += 1
    end = len(before) - suffix
    after_end = len(after) - suffix
    # Anchor pure insertions to a neighboring character so the existing range
    # writer can make the edit while preserving text outside that range.
    while start > 0 and not before[start:end].strip():
        start -= 1
    while end < len(before) and not before[start:end].strip():
        end += 1
        after_end += 1
    previous = before[start:end]
    replacement = after[start:after_end]
    if not previous.strip() or len(previous) > 500 or len(replacement) > 20_000:
        return None
    return start, end, replacement


def suggest_related_edits(
    session: Session, version: DocumentVersion, original: bytes, draft: bytes,
) -> list[RelatedEdit]:
    old = _paragraphs(original, version)
    new = _paragraphs(draft, version)
    if [_position(item) for item in old] != [_position(item) for item in new]:
        return []

    original_counts = Counter((_context(item), item.text) for item in old)
    remaining_text = {(_context(item), item.text) for item in new}
    changes = {}
    for before, after in zip(old, new):
        key = (_context(before), before.text)
        if before.text == after.text or original_counts[key] != 1 or key in remaining_text:
            continue
        if _context(before) != _context(after):
            continue
        span = _changed_span(before.text, after.text)
        if span is not None and before.editability_for_range(*span[:2])[0]:
            changes[key] = after.text, span
    if not changes:
        return []

    related = session.scalars(
        select(DocumentVersion)
        .join(DocumentHead, DocumentHead.current_version_id == DocumentVersion.id)
        .join(DocumentRecord, DocumentRecord.id == DocumentHead.document_id)
        .where(DocumentRecord.document_set_id == version.document.document_set_id,
               DocumentRecord.id != version.document_id)
        .order_by(DocumentRecord.original_name, DocumentRecord.id)
    )
    suggestions = []
    for candidate in related:
        matches = defaultdict(list)
        for segment in _paragraphs(document_version_path(candidate).read_bytes(), candidate):
            key = (_context(segment), segment.text)
            if key in changes:
                matches[key].append(segment)
        for key, segments in matches.items():
            if len(segments) != 1:
                continue
            segment = segments[0]
            after, (start, end, replacement) = changes[key]
            query = segment.text[start:end]
            if not segment.editability_for_range(start, end)[0]:
                continue
            if (start, end) not in find_occurrence_ranges(segment.text, query, match_case=True):
                continue
            target = FindReplaceOccurrenceTarget(
                occurrence_id=occurrence_id(segment, start, end),
                segment_id=segment.segment_id,
                document_id=candidate.document_id,
                version_id=candidate.id,
                part_path=segment.part_path,
                structure_type=segment.structure_type,
                match_start=start,
                match_end=end,
                matched_text=query,
                location=segment.location,
            )
            suggestions.append(RelatedEdit(candidate.document.original_name, segment.text, after, replacement, target))
    return suggestions


def related_operations(edits: list[RelatedEdit]) -> list[EditBatchOperationRequest]:
    grouped = defaultdict(list)
    for edit in edits:
        grouped[(edit.target.matched_text, edit.replacement)].append(edit.target)
    return [
        EditBatchOperationRequest(
            operation_type="find_replace", label="ONLYOFFICE paragraph edit",
            replacement_text=replacement,
            find_request=TextSearchRequest(query=query, match_case=True), occurrences=targets,
        )
        for (query, replacement), targets in grouped.items()
    ]
