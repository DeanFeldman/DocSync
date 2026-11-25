"""Apply wording changes to exact paragraph matches in the same document set."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from .editor_service import document_version_path
from .find_replace_service import bind_inventory_to_revisions
from .models import DocumentBlockRevision, DocumentHead, DocumentRecord, DocumentVersion
from .text_inventory_service import (
    DocumentTextInventory,
    DocumentTextSegment,
    ParagraphInsertion,
    TextReplacementPatch,
    apply_text_replacements,
    build_text_inventory,
    occurrence_id,
)


def _paragraphs(inventory: DocumentTextInventory) -> list[DocumentTextSegment]:
    return [
        segment for segment in inventory.segments
        if segment.location.get("kind") in {"body", "table_paragraph", "header_paragraph", "footer_paragraph"}
        and segment.structure_type not in {"field_instruction", "tracked_delete"}
    ]


def _container(segment: DocumentTextSegment) -> tuple:
    location = segment.location
    cell = tuple((part["table_index"], part["row_index"], part["column_index"])
                 for part in location.get("table_path", []))
    return (segment.part_path, location["kind"], cell)


def _context(segment: DocumentTextSegment) -> tuple:
    location = segment.location
    kind = location.get("part_kind") or location["kind"]
    if kind in {"body", "table_paragraph"}:
        kind = "main"
    return (kind, location.get("header_footer_type"))


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
    if not previous.strip():
        return None
    return start, end, replacement


def _wording(segment: DocumentTextSegment) -> str:
    return " ".join(segment.text.split())


def _actual_span(text: str, start: int, end: int) -> tuple[int, int]:
    # Count each whitespace run as one character, as in _wording, and keep
    # the original offsets for DOCX write-back.
    trimmed_start = len(text) - len(text.lstrip())
    spans = list(re.finditer(r"\s+|\S", text.strip()))
    return trimmed_start + spans[start].start(), trimmed_start + spans[end - 1].end()


def _wording_key(segment: DocumentTextSegment) -> tuple[tuple, str]:
    return _context(segment), _wording(segment)


def _detached_revisions(session: Session, inventory: DocumentTextInventory) -> set[str]:
    detached = set(session.scalars(
        select(DocumentBlockRevision.id).where(
            DocumentBlockRevision.version_id == inventory.version_id,
            DocumentBlockRevision.shared_state == "detached",
        )
    ))
    if detached:
        bind_inventory_to_revisions(session, inventory)
    return detached


def _paragraph_changes(
    before: list[DocumentTextSegment],
    after: list[DocumentTextSegment],
    detached: set[str],
) -> dict[tuple[tuple, str], tuple[int, int, str]]:
    old = [_wording_key(segment) for segment in before]
    new = [_wording_key(segment) for segment in after]
    original_counts = Counter(old)
    remaining = set(new)
    changes = {}
    matcher = SequenceMatcher(a=old, b=new, autojunk=False)
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag == "replace" and old_end - old_start == new_end - new_start:
            pairs = zip(before[old_start:old_end], after[new_start:new_end])
        elif tag == "delete" and new:
            # A deleted paragraph has no new paragraph to pair with. Clear
            # the corresponding wording in other files without reflowing
            # their table rows, paragraphs, or numbering.
            pairs = ((paragraph, None) for paragraph in before[old_start:old_end])
        else:
            continue
        for previous, updated in pairs:
            key = _wording_key(previous)
            if previous.revision_id in detached or original_counts[key] != 1 or key in remaining:
                continue
            if updated is not None and _container(previous) != _container(updated):
                continue
            span = _changed_span(key[1], _wording(updated) if updated is not None else "")
            if span is None:
                continue
            start, end = _actual_span(previous.text, *span[:2])
            if previous.editability_for_range(start, end, allow_whitespace_deletion=not span[2])[0]:
                changes[key] = span
    return changes


@dataclass(frozen=True)
class ParagraphAddition:
    previous: tuple[tuple, str] | None
    following: tuple[tuple, str] | None
    kind: str
    blank_count: int
    texts: tuple[str, ...]


def _paragraph_groups(paragraphs: list[DocumentTextSegment]) -> dict[tuple, list[DocumentTextSegment]]:
    groups = defaultdict(list)
    for paragraph in paragraphs:
        groups[_container(paragraph)].append(paragraph)
    return groups


def _paragraph_additions(
    before: list[DocumentTextSegment],
    after: list[DocumentTextSegment],
    detached: set[str],
) -> list[ParagraphAddition]:
    before_groups = _paragraph_groups(before)
    counts = Counter(_wording_key(paragraph) for paragraph in before)
    additions = []
    for container, paragraphs in _paragraph_groups(after).items():
        original = before_groups.get(container)
        kind = container[1]
        if not original or kind not in {"body", "table_paragraph"}:
            continue
        old = [_wording(paragraph) for paragraph in original]
        new = [_wording(paragraph) for paragraph in paragraphs]
        matcher = SequenceMatcher(a=old, b=new, autojunk=False)
        for tag, start, end, new_start, new_end in matcher.get_opcodes():
            if tag == "insert":
                blank_count = 0
            elif tag == "replace" and end - start == new_end - new_start and not any(old[start:end]):
                blank_count = end - start
            else:
                continue
            if not any(new[new_start:new_end]):
                continue
            block = paragraphs[new_start:new_end]
            if any(
                span.role != "ordinary" or span.node_kind not in {"text", "tab", "line_break"}
                or span.hyperlink_key or span.content_control_key
                for paragraph in block for span in paragraph.spans
            ):
                continue
            previous = original[start - 1] if start else None
            following = original[end] if end < len(original) else None
            if previous is None and following is None:
                continue
            if any(
                not _wording(anchor) or counts[_wording_key(anchor)] != 1 or anchor.revision_id in detached
                for anchor in (previous, following) if anchor is not None
            ):
                continue
            if previous is not None and (not new_start or new[new_start - 1] != old[start - 1]):
                continue
            if following is not None and (new_end == len(new) or new[new_end] != old[end]):
                continue
            additions.append(ParagraphAddition(
                _wording_key(previous) if previous else None,
                _wording_key(following) if following else None,
                kind,
                blank_count,
                tuple(paragraph.text for paragraph in block),
            ))
    return additions


def _target_insertions(
    paragraphs: list[DocumentTextSegment],
    additions: list[ParagraphAddition],
    detached: set[str],
) -> tuple[ParagraphInsertion, ...]:
    groups = _paragraph_groups(paragraphs)
    by_wording = defaultdict(list)
    for paragraph in paragraphs:
        by_wording[_wording_key(paragraph)].append(paragraph)
    insertions = []
    for addition in additions:
        before = by_wording.get(addition.previous, [])
        after = by_wording.get(addition.following, [])
        if (addition.previous is not None and len(before) != 1) or (
            addition.following is not None and len(after) != 1
        ):
            continue
        previous = before[0] if before else None
        following = after[0] if after else None
        container = _container(previous or following)
        if container[1] != addition.kind or any(
            _container(anchor) != container or anchor.revision_id in detached
            for anchor in (previous, following) if anchor is not None
        ):
            continue
        group = groups[container]
        start = group.index(previous) + 1 if previous is not None else 0
        end = group.index(following) if following is not None else len(group)
        if end - start != addition.blank_count or any(_wording(item) for item in group[start:end]):
            continue
        insertions.append(ParagraphInsertion(
            previous_id=previous.segment_id if previous else None,
            next_id=following.segment_id if following else None,
            empty_ids=tuple(item.segment_id for item in group[start:end]),
            texts=addition.texts,
        ))
    return tuple(insertions)


def sync_related_paragraphs(
    session: Session, version: DocumentVersion, original: bytes, edited: bytes,
) -> dict[str, tuple[str, bytes]]:
    inventory_options = {
        "document_id": version.document_id, "version_id": version.id, "include_empty_paragraphs": True,
    }
    original_inventory = build_text_inventory(original, **inventory_options)
    detached = _detached_revisions(session, original_inventory)
    before = _paragraphs(original_inventory)
    after = _paragraphs(build_text_inventory(edited, **inventory_options))
    changes = _paragraph_changes(before, after, detached)
    additions = _paragraph_additions(before, after, detached)
    if not changes and not additions:
        return {}

    candidates = session.scalars(
        select(DocumentVersion)
        .join(DocumentHead, DocumentHead.current_version_id == DocumentVersion.id)
        .join(DocumentRecord, DocumentRecord.id == DocumentHead.document_id)
        .where(DocumentRecord.document_set_id == version.document.document_set_id,
               DocumentRecord.id != version.document_id)
    )
    synced = {}
    for candidate in candidates:
        content = document_version_path(candidate).read_bytes()
        inventory = build_text_inventory(
            content, document_id=candidate.document_id, version_id=candidate.id,
            include_empty_paragraphs=bool(additions),
        )
        paragraphs = _paragraphs(inventory)
        matches = defaultdict(list)
        for segment in paragraphs:
            key = _wording_key(segment)
            if key in changes:
                matches[key].append(segment)
        if not matches and not additions:
            continue
        detached = _detached_revisions(session, inventory)
        patches = []
        for key, segments in matches.items():
            if len(segments) != 1:
                continue
            segment = segments[0]
            start, end, replacement = changes[key]
            start, end = _actual_span(segment.text, start, end)
            if segment.revision_id in detached or not segment.editability_for_range(
                start, end, allow_whitespace_deletion=not replacement,
            )[0]:
                continue
            patches.append(TextReplacementPatch(
                occurrence_id=occurrence_id(segment, start, end),
                segment_id=segment.segment_id,
                part_path=segment.part_path,
                match_start=start,
                match_end=end,
                expected_text=segment.text[start:end],
                replacement_text=replacement,
                allow_whitespace_deletion=not replacement,
            ))
        insertions = _target_insertions(paragraphs, additions, detached) if additions else ()
        if patches or insertions:
            updated = apply_text_replacements(content, inventory, patches, insertions=insertions)
            if updated != content:
                synced[candidate.document_id] = (candidate.id, updated)
    return synced
