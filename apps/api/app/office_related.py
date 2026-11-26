"""Apply changes to matching paragraphs and tables in the same document set."""

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
    DocumentTable,
    DocumentTextInventory,
    DocumentTextSegment,
    ParagraphInsertion,
    ParagraphNumbering,
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


def _table_for_segment(
    segment: DocumentTextSegment, tables: dict[tuple[int, ...], DocumentTable],
) -> DocumentTable | None:
    if segment.part_path != "word/document.xml" or not segment.location.get("table_path"):
        return None
    return tables.get(segment.node_path[:2])


def _table_alignments(
    before: list[DocumentTable], after: list[DocumentTable],
) -> tuple[dict[int, int], list[DocumentTable]]:
    old = [table.signature for table in before]
    new = [table.signature for table in after]
    if len(old) == len(new):
        return dict(zip(range(len(old)), range(len(new)))), []

    counts = Counter(old)
    new_signatures = set(new)
    pairs = {}
    removed = []
    for tag, left, left_end, right, right_end in SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag == "equal":
            pairs.update(zip(range(left, left_end), range(right, right_end)))
            continue
        old_gap = before[left:left_end]
        new_gap = after[right:right_end]
        if tag == "replace":
            # A surviving table may have been edited in the same save. Pair it
            # using uniquely shared wording before checking the deletion gaps.
            pairs_in_gap = []
            for previous in old_gap:
                matches = [table for table in new_gap if previous.wording & table.wording]
                if len(matches) == 1 and sum(bool(item.wording & matches[0].wording) for item in old_gap) == 1:
                    pairs_in_gap.append((previous.index, matches[0].index))
            if any(a[1] >= b[1] for a, b in zip(pairs_in_gap, pairs_in_gap[1:])):
                continue
            pairs.update(pairs_in_gap)
        else:
            pairs_in_gap = []
        if len(old_gap) <= len(new_gap):
            continue
        anchors = [(left - 1, right - 1), *pairs_in_gap, (left_end, right_end)]
        for (i, j), (next_i, next_j) in zip(anchors, anchors[1:]):
            if next_j == j + 1:
                removed.extend(
                    table for table in before[i + 1:next_i]
                    if table.wording and counts[table.signature] == 1 and table.signature not in new_signatures
                )
    return pairs, removed


def _paragraph_alignments(
    before: list[DocumentTextSegment], after: list[DocumentTextSegment],
    body_tables: dict[tuple[int, ...], DocumentTable], table_pairs: dict[int, int],
):
    """Align paragraphs within each Word container, ignoring blank paragraphs as anchors."""
    after_groups = _paragraph_groups(after)
    for container, original in _paragraph_groups(before).items():
        target_container = container
        table = _table_for_segment(original[0], body_tables)
        if table is not None:
            new_index = table_pairs.get(table.index)
            if new_index is None:
                continue
            part, kind, ((_, row, column), *nested_cells) = container
            target_container = (part, kind, ((new_index, row, column), *nested_cells))
        updated = after_groups.get(target_container, [])
        old = [(index, _wording(item)) for index, item in enumerate(original) if _wording(item)]
        new = [(index, _wording(item)) for index, item in enumerate(updated) if _wording(item)]
        matcher = SequenceMatcher(a=[text for _, text in old], b=[text for _, text in new], autojunk=False)
        anchors = []
        for tag, left, left_end, right, right_end in matcher.get_opcodes():
            if tag == "equal" or (tag == "replace" and left_end - left == right_end - right):
                anchors.extend((old[i][0], new[j][0]) for i, j in zip(
                    range(left, left_end), range(right, right_end),
                ))
            elif tag == "replace":
                # An edited paragraph can sit beside new or deleted paragraphs in the same
                # save. Pair wording only when both sides independently identify the match.
                anchors.extend(_similar_pairs(old[left:left_end], new[right:right_end]))
        yield container, original, updated, anchors


def _similar_pairs(old: list[tuple[int, str]], new: list[tuple[int, str]]) -> list[tuple[int, int]]:
    scores = [
        [SequenceMatcher(a=before, b=after, autojunk=False).ratio() for _, after in new]
        for _, before in old
    ]
    pairs = []
    for left, row in enumerate(scores):
        best = max(row)
        if best < 0.6 or row.count(best) != 1:
            continue
        right = row.index(best)
        column = [other[right] for other in scores]
        if best == max(column) and column.count(best) == 1:
            pairs.append((old[left][0], new[right][0]))
    if any(first[1] >= second[1] for first, second in zip(pairs, pairs[1:])):
        return []
    return pairs


@dataclass(frozen=True)
class WordingEdit:
    start: int
    end: int
    replacement: str
    raw_before: str | None = None

    def offsets_in(self, text: str) -> tuple[int, int]:
        if self.raw_before is not None:
            return self.start, self.end
        return _actual_span(text, self.start, self.end)

    def editable_in(self, segment: DocumentTextSegment) -> bool:
        start, end = self.offsets_in(segment.text)
        return segment.editability_for_range(
            start, end, allow_whitespace_deletion=not self.replacement,
            allow_soft_breaks=self.raw_before is not None,
        )[0]


def _paragraph_changes(before, after, alignments, detached):
    counts = Counter(_wording_key(segment) for segment in before)
    remaining = {_wording_key(segment) for segment in after}
    changes = {}
    deletions = set()
    blocked = {}
    for _container_key, original, updated, anchors in alignments:
        boundaries = [(-1, -1), *anchors, (len(original), len(updated))]
        pairs = [(original[i], updated[j]) for i, j in anchors]
        for (left, right), (end, new_end) in zip(boundaries, boundaries[1:]):
            old_gap = original[left + 1:end]
            new_gap = updated[right + 1:new_end]
            if new_gap and len(old_gap) == len(new_gap) and not any(map(_wording, new_gap)):
                # Clearing selected text leaves a paragraph mark. Keep it in matching files too.
                pairs.extend(zip(old_gap, new_gap))
            elif anchors and not new_gap:
                for paragraph in old_gap:
                    key = _wording_key(paragraph)
                    if not key[1] or key in remaining:
                        continue
                    if counts[key] != 1:
                        blocked[key] = "ambiguous"
                    elif paragraph.revision_id in detached:
                        blocked[key] = "source_detached"
                    else:
                        deletions.add(key)

        for previous, replacement in pairs:
            key = _wording_key(previous)
            new_wording = _wording(replacement)
            if not key[1]:
                continue
            raw_before = None
            if key[1] == new_wording:
                if previous.text == replacement.text:
                    continue
                span = _changed_span(previous.text, replacement.text)
                if span is None or "\n" not in previous.text[span[0]:span[1]] + span[2]:
                    continue
                raw_before = previous.text
            else:
                if key in remaining and counts[key] == 1:
                    continue
                span = _changed_span(key[1], new_wording)
            if span is None:
                continue
            edit = WordingEdit(*span, raw_before=raw_before)
            if counts[key] != 1:
                blocked[key] = "ambiguous"
            elif previous.revision_id in detached:
                blocked[key] = "source_detached"
            elif edit.editable_in(previous):
                changes[key] = edit
            else:
                blocked[key] = "source_protected"
    return changes, deletions, blocked


@dataclass(frozen=True)
class ListContinuation:
    numbering: ParagraphNumbering
    follows_previous: bool
    precedes_next: bool

    def in_target(
        self, previous: DocumentTextSegment | None, following: DocumentTextSegment | None,
    ) -> ParagraphNumbering | None:
        for is_anchor, paragraph in ((self.follows_previous, previous), (self.precedes_next, following)):
            target = paragraph.numbering if is_anchor and paragraph is not None else None
            if target and (target.level, target.is_bullet) == (self.numbering.level, self.numbering.is_bullet):
                return target
        return None


def _list_continuation(
    paragraph: DocumentTextSegment,
    previous: DocumentTextSegment | None,
    following: DocumentTextSegment | None,
) -> ListContinuation | None:
    numbering = paragraph.numbering
    if numbering is None:
        return None

    def same_list(anchor: DocumentTextSegment | None) -> bool:
        other = anchor.numbering if anchor is not None else None
        return other is not None and (other.num_id, other.level) == (numbering.num_id, numbering.level)

    follows_previous, precedes_next = same_list(previous), same_list(following)
    if follows_previous or precedes_next:
        return ListContinuation(numbering, follows_previous, precedes_next)
    return None


@dataclass(frozen=True)
class ParagraphAddition:
    previous: tuple[tuple, str] | None
    following: tuple[tuple, str] | None
    kind: str
    blank_count: int
    texts: tuple[str, ...]
    continuations: tuple[ListContinuation | None, ...]


def _paragraph_groups(paragraphs: list[DocumentTextSegment]) -> dict[tuple, list[DocumentTextSegment]]:
    groups = defaultdict(list)
    for paragraph in paragraphs:
        groups[_container(paragraph)].append(paragraph)
    return groups


def _paragraph_additions(
    before: list[DocumentTextSegment],
    alignments: list,
    detached: set[str],
) -> list[ParagraphAddition]:
    counts = Counter(_wording_key(paragraph) for paragraph in before)
    additions = []
    for container, original, paragraphs, pairs in alignments:
        kind = container[1]
        if kind not in {"body", "table_paragraph", "header_paragraph", "footer_paragraph"}:
            continue
        old = [_wording(paragraph) for paragraph in original]
        new = [_wording(paragraph) for paragraph in paragraphs]
        anchors = [(-1, -1), *pairs, (len(old), len(new))]

        for (old_previous, new_previous), (end, new_end) in zip(anchors, anchors[1:]):
            start, new_start = old_previous + 1, new_previous + 1
            old_gap, new_gap = old[start:end], new[new_start:new_end]
            if old_gap == new_gap or any(old_gap):
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
            edited_previous = paragraphs[new_previous] if new_previous >= 0 else None
            edited_following = paragraphs[new_end] if new_end < len(paragraphs) else None
            additions.append(ParagraphAddition(
                _wording_key(previous) if previous else None,
                _wording_key(following) if following else None,
                kind,
                blank_count,
                tuple(paragraph.text for paragraph in block),
                tuple(_list_continuation(paragraph, edited_previous, edited_following) for paragraph in block),
            ))
    return additions


def _numbered_predecessor(
    groups: dict[tuple, list[DocumentTextSegment]],
    following: DocumentTextSegment | None,
    addition: ParagraphAddition,
) -> DocumentTextSegment | None:
    if following is None or following.numbering is None or not any(
        continuation and continuation.follows_previous and continuation.precedes_next
        and continuation.in_target(None, following) is not None
        for continuation in addition.continuations
    ):
        return None
    group = groups[_container(following)]
    index = group.index(following) - addition.blank_count - 1
    if index < 0:
        return None
    previous = group[index]
    number = previous.numbering
    next_number = following.numbering
    if number and (number.num_id, number.level) == (next_number.num_id, next_number.level):
        return previous
    return None


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
        if len(before) > 1 or len(after) > 1:
            continue
        previous = before[0] if before else None
        following = after[0] if after else None
        if addition.previous is not None and previous is None:
            previous = _numbered_predecessor(groups, following, addition)
            if previous is None:
                continue
        anchor = previous or following
        if anchor is None:
            continue
        container = _container(anchor)
        if container[1] != addition.kind:
            continue
        group = groups[container]
        start = group.index(previous) + 1 if previous is not None else 0
        if following is None and previous is not None and start + addition.blank_count < len(group):
            # An insertion immediately after a unique preceding match can
            # keep the target's next, file-specific paragraph.
            next_index = start + addition.blank_count
            following = group[next_index]
            existing = tuple(_wording(item) for item in group[start:start + len(addition.texts)])
            inserted = tuple(" ".join(text.split()) for text in addition.texts)
            if not _wording(following) or existing == inserted:
                continue
        if addition.following is not None and following is None:
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
            numbering=tuple(
                continuation.in_target(previous, following) if continuation else None
                for continuation in addition.continuations
            ),
        ))
    return tuple(insertions)


def _differing_table_row(source: DocumentTable, target: DocumentTable) -> int | None:
    # A corresponding table must occupy the same position, have the same
    # cell layout and share at least two complete, non-empty rows. A different
    # row is file-specific and may only be removed after review.
    if source.index != target.index or len(source.signature) != len(target.signature):
        return None
    differing_rows = []
    shared_rows = 0
    for index, (left, right) in enumerate(zip(source.signature, target.signature), 1):
        if tuple(merge for merge, _ in left) != tuple(merge for merge, _ in right):
            return None
        if left != right:
            differing_rows.append(index)
        elif any(text for _, blocks in left for text in blocks if isinstance(text, str)):
            shared_rows += 1
    if shared_rows >= 2 and len(differing_rows) == 1:
        return differing_rows[0]
    return None


def _target_table_removals(
    paragraphs: list[DocumentTextSegment],
    tables: list[DocumentTable],
    removed_tables: list[DocumentTable],
    source_detached: set[DocumentTable],
    detached: set[str],
) -> tuple[list[DocumentTable], set[str], list[tuple[DocumentTable, int]]]:
    by_signature = defaultdict(list)
    by_path = {table.node_path: table for table in tables}
    for table in tables:
        by_signature[table.signature].append(table)
    detached_tables = {
        table for segment in paragraphs if segment.revision_id in detached
        if (table := _table_for_segment(segment, by_path)) is not None
    }
    removals = []
    review = []
    reasons = set()
    for source in removed_tables:
        matches = by_signature[source.signature]
        if not matches:
            if source.index < len(tables) and source not in source_detached and source.removable:
                candidate = tables[source.index]
                if candidate.removable and candidate not in detached_tables:
                    row = _differing_table_row(source, candidate)
                    if row is not None:
                        review.append((candidate, row))
            continue
        if len(matches) != 1:
            reasons.add("ambiguous")
            continue
        target = matches[0]
        if source in source_detached:
            reasons.add("source_detached")
        elif target in detached_tables:
            reasons.add("detached")
        elif not source.removable or not target.removable:
            reasons.add("protected")
        else:
            removals.append(target)
    return removals, reasons, [(table, row) for table, row in review if table not in removals]


def sync_related_paragraphs(
    session: Session, version: DocumentVersion, original: bytes, edited: bytes,
) -> tuple[dict[str, tuple[str, bytes]], list[dict], list[dict]]:
    inventory_options = {
        "document_id": version.document_id, "version_id": version.id, "include_empty_paragraphs": True,
        "include_paragraph_lists": True, "include_body_tables": True,
    }
    original_inventory = build_text_inventory(original, **inventory_options)
    detached = _detached_revisions(session, original_inventory)
    before = _paragraphs(original_inventory)
    edited_inventory = build_text_inventory(edited, **inventory_options)
    after = _paragraphs(edited_inventory)
    table_pairs, removed_tables = _table_alignments(original_inventory.body_tables, edited_inventory.body_tables)
    body_tables = {table.node_path: table for table in original_inventory.body_tables}
    detached_tables = {
        table for segment in before if segment.revision_id in detached
        if (table := _table_for_segment(segment, body_tables)) is not None
    }
    alignments = list(_paragraph_alignments(before, after, body_tables, table_pairs))
    changes, deletions, blocked = _paragraph_changes(before, after, alignments, detached)
    additions = _paragraph_additions(before, alignments, detached)
    if not (changes or deletions or additions or blocked or removed_tables):
        return {}, [], []

    candidates = session.scalars(
        select(DocumentVersion)
        .join(DocumentHead, DocumentHead.current_version_id == DocumentVersion.id)
        .join(DocumentRecord, DocumentRecord.id == DocumentHead.document_id)
        .where(DocumentRecord.document_set_id == version.document.document_set_id,
               DocumentRecord.id != version.document_id)
    )
    synced = {}
    skipped = []
    table_review = []
    for candidate in candidates:
        content = document_version_path(candidate).read_bytes()
        inventory = build_text_inventory(
            content, document_id=candidate.document_id, version_id=candidate.id,
            include_empty_paragraphs=bool(additions), include_paragraph_lists=bool(additions),
            include_body_tables=bool(removed_tables),
        )
        paragraphs = _paragraphs(inventory)
        if removed_tables:
            detached = _detached_revisions(session, inventory)
            table_removals, reasons, proposed = _target_table_removals(
                paragraphs, inventory.body_tables, removed_tables, detached_tables, detached,
            )
            if proposed:
                table_review.append({
                    "document_id": candidate.document_id,
                    "document_name": candidate.document.original_name,
                    "version_id": candidate.id,
                    "tables": [{
                        "index": table.index - sum(item.index < table.index for item in table_removals),
                        "table_number": table.index + 1,
                        "different_row": row,
                    } for table, row in proposed],
                })
            removed_lookup = {table.node_path: table for table in table_removals}
            paragraphs = [
                segment for segment in paragraphs if _table_for_segment(segment, removed_lookup) is None
            ]
        else:
            table_removals, reasons = [], set()
            detached = set()
        matches = defaultdict(list)
        for segment in paragraphs:
            key = _wording_key(segment)
            if key in changes or key in deletions or key in blocked:
                matches[key].append(segment)
        if not (matches or additions or table_removals or reasons):
            continue
        if not removed_tables:
            detached = _detached_revisions(session, inventory)
        patches = []
        removals = []
        for key, segments in matches.items():
            if key in blocked:
                reasons.add(blocked[key])
                continue
            if len(segments) != 1:
                reasons.add("ambiguous")
                continue
            segment = segments[0]
            if segment.revision_id in detached:
                reasons.add("detached")
                continue
            if key in deletions:
                removals.append(segment.segment_id)
                continue
            edit = changes[key]
            if edit.raw_before is not None and edit.raw_before != segment.text:
                continue
            start, end = edit.offsets_in(segment.text)
            if not edit.editable_in(segment):
                reasons.add("protected")
                continue
            patches.append(TextReplacementPatch(
                occurrence_id=occurrence_id(segment, start, end),
                segment_id=segment.segment_id,
                part_path=segment.part_path,
                match_start=start,
                match_end=end,
                expected_text=segment.text[start:end],
                replacement_text=edit.replacement,
                allow_whitespace_deletion=not edit.replacement,
                allow_soft_breaks=edit.raw_before is not None,
            ))
        insertions = _target_insertions(paragraphs, additions, detached) if additions else ()
        if patches or insertions or removals or table_removals:
            protected_structures = []
            updated = apply_text_replacements(
                content, inventory, patches, insertions=insertions, paragraph_removals=tuple(removals),
                table_removals=tuple(table_removals), skipped_structures=protected_structures,
            )
            if protected_structures:
                reasons.add("protected")
            if updated != content:
                synced[candidate.document_id] = (candidate.id, updated)
        if reasons:
            skipped.append({
                "document_id": candidate.document_id,
                "document_name": candidate.document.original_name,
                "reasons": sorted(reasons),
            })
    return (
        synced,
        sorted(skipped, key=lambda file: file["document_name"].casefold()),
        sorted(table_review, key=lambda file: file["document_name"].casefold()),
    )
