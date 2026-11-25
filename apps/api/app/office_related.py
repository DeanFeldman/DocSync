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
    # Use just one adjacent non-whitespace character for insertions. Including
    # a neighboring tab or line break makes an otherwise valid edit protected.
    if start == end:
        if start < len(before) and not before[start].isspace():
            end += 1
            after_end += 1
        elif start > 0 and not before[start - 1].isspace():
            start -= 1
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
) -> tuple[dict[tuple[tuple, str], tuple[int, int, str]], dict[tuple[tuple, str], str]]:
    old = [_wording_key(segment) for segment in before]
    new = [_wording_key(segment) for segment in after]
    original_counts = Counter(old)
    remaining = set(new)
    changes = {}
    blocked = {}
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
            if original_counts[key] != 1 or key in remaining:
                continue
            if updated is not None and _container(previous) != _container(updated):
                continue
            span = _changed_span(key[1], _wording(updated) if updated is not None else "")
            if span is None:
                continue
            start, end = _actual_span(previous.text, *span[:2])
            if previous.revision_id in detached:
                blocked[key] = "source_detached"
            elif previous.editability_for_range(start, end, allow_whitespace_deletion=not span[2])[0]:
                changes[key] = span
            else:
                blocked[key] = "source_protected"
    return changes, blocked


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
        # Blank paragraphs are content within a gap, not anchors. Aligning
        # them as anchors can move a blank from one gap to a different one.
        old_text = [(index, wording) for index, wording in enumerate(old) if wording]
        new_text = [(index, wording) for index, wording in enumerate(new) if wording]
        matcher = SequenceMatcher(
            a=[item[1] for item in old_text], b=[item[1] for item in new_text], autojunk=False,
        )
        anchors = [(-1, -1)]
        for left, right, count in matcher.get_matching_blocks():
            anchors.extend((old_text[left + i][0], new_text[right + i][0]) for i in range(count))
        anchors.append((len(old), len(new)))

        for (old_previous, new_previous), (end, new_end) in zip(anchors, anchors[1:]):
            start, new_start = old_previous + 1, new_previous + 1
            old_gap, new_gap = old[start:end], new[new_start:new_end]
            if not new_gap or old_gap == new_gap or any(old_gap) or len(old_gap) > len(new_gap):
                continue
            blank_count = len(old_gap)
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
        if (addition.previous is not None and len(before) != 1) or len(after) > 1:
            continue
        previous = before[0] if before else None
        following = after[0] if after else None
        anchor = previous or following
        if anchor is None:
            continue
        container = _container(anchor)
        if container[1] != addition.kind:
            continue
        group = groups[container]
        start = group.index(previous) + 1 if previous is not None else 0
        if addition.following is not None and following is None:
            # An insertion immediately after a unique preceding match can
            # keep the target's next, file-specific paragraph.
            next_index = start + addition.blank_count
            if previous is None or next_index >= len(group):
                continue
            following = group[next_index]
            existing = tuple(_wording(item) for item in group[start:start + len(addition.texts)])
            inserted = tuple(" ".join(text.split()) for text in addition.texts)
            if not _wording(following) or existing == inserted:
                continue
        if any(
            _container(item) != container or item.revision_id in detached
            for item in (previous, following) if item is not None
        ):
            continue
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
) -> tuple[dict[str, tuple[str, bytes]], list[dict]]:
    inventory_options = {
        "document_id": version.document_id, "version_id": version.id, "include_empty_paragraphs": True,
    }
    original_inventory = build_text_inventory(original, **inventory_options)
    detached = _detached_revisions(session, original_inventory)
    before = _paragraphs(original_inventory)
    after = _paragraphs(build_text_inventory(edited, **inventory_options))
    changes, blocked = _paragraph_changes(before, after, detached)
    additions = _paragraph_additions(before, after, detached)
    if not changes and not additions and not blocked:
        return {}, []

    candidates = session.scalars(
        select(DocumentVersion)
        .join(DocumentHead, DocumentHead.current_version_id == DocumentVersion.id)
        .join(DocumentRecord, DocumentRecord.id == DocumentHead.document_id)
        .where(DocumentRecord.document_set_id == version.document.document_set_id,
               DocumentRecord.id != version.document_id)
    )
    synced = {}
    skipped = []
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
            if key in changes or key in blocked:
                matches[key].append(segment)
        if not matches and not additions:
            continue
        detached = _detached_revisions(session, inventory)
        patches = []
        reasons = set()
        for key, segments in matches.items():
            if key in blocked:
                reasons.add(blocked[key])
                continue
            if len(segments) != 1:
                reasons.add("ambiguous")
                continue
            segment = segments[0]
            start, end, replacement = changes[key]
            start, end = _actual_span(segment.text, start, end)
            if segment.revision_id in detached:
                reasons.add("detached")
                continue
            if not segment.editability_for_range(start, end, allow_whitespace_deletion=not replacement)[0]:
                reasons.add("protected")
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
        if reasons:
            skipped.append({
                "document_id": candidate.document_id,
                "document_name": candidate.document.original_name,
                "reasons": sorted(reasons),
            })
    return synced, sorted(skipped, key=lambda file: file["document_name"].casefold())
