from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
import hashlib
from pathlib import Path
import posixpath
import unicodedata
from uuid import NAMESPACE_URL, uuid5
import zipfile

from fastapi import HTTPException
from lxml import etree


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"

NS = {
    "w": WORD_NS,
    "r": REL_NS,
    "pr": PACKAGE_REL_NS,
    "a": DRAWING_NS,
}


def _qname(namespace: str, local_name: str) -> str:
    return f"{{{namespace}}}{local_name}"


W_P = _qname(WORD_NS, "p")
W_T = _qname(WORD_NS, "t")
W_DEL_TEXT = _qname(WORD_NS, "delText")
W_INSTR_TEXT = _qname(WORD_NS, "instrText")
W_TAB = _qname(WORD_NS, "tab")
W_BR = _qname(WORD_NS, "br")
W_CR = _qname(WORD_NS, "cr")
W_NO_BREAK_HYPHEN = _qname(WORD_NS, "noBreakHyphen")
W_SOFT_HYPHEN = _qname(WORD_NS, "softHyphen")
W_SYM = _qname(WORD_NS, "sym")
W_FLD_CHAR = _qname(WORD_NS, "fldChar")
W_HYPERLINK = _qname(WORD_NS, "hyperlink")
W_SDT = _qname(WORD_NS, "sdt")
W_SDT_CONTENT = _qname(WORD_NS, "sdtContent")
W_INS = _qname(WORD_NS, "ins")
W_DEL = _qname(WORD_NS, "del")
W_TXBX_CONTENT = _qname(WORD_NS, "txbxContent")
W_TBL = _qname(WORD_NS, "tbl")
W_TR = _qname(WORD_NS, "tr")
W_TC = _qname(WORD_NS, "tc")
W_BODY = _qname(WORD_NS, "body")
W_FOOTNOTE = _qname(WORD_NS, "footnote")
W_ENDNOTE = _qname(WORD_NS, "endnote")
W_COMMENT = _qname(WORD_NS, "comment")
A_P = _qname(DRAWING_NS, "p")
A_T = _qname(DRAWING_NS, "t")


PROTECTED_FIELD_RESULT = "This match is inside a protected Word field result."
PROTECTED_FIELD_INSTRUCTION = "This match is inside a protected Word field instruction."
PROTECTED_TRACKED_DELETION = "This match is historical text inside a tracked deletion."
PROTECTED_DRAWING = (
    "This text is inside a DrawingML structure that DocSync can detect but cannot "
    "safely modify yet."
)
PROTECTED_SPECIAL_CHARACTER = (
    "This match crosses a Word tab, line break, symbol, or other protected character."
)
PROTECTED_HYPERLINK_BOUNDARY = (
    "This match crosses a hyperlink boundary. Select text wholly inside or outside "
    "the hyperlink so its destination can be preserved."
)
PROTECTED_CONTROL_BOUNDARY = (
    "This match crosses a content-control boundary and cannot be modified safely."
)
PROTECTED_REVISION_BOUNDARY = (
    "This match crosses a tracked-change boundary and cannot be modified safely."
)


@dataclass(frozen=True)
class TextNodeSpan:
    node_path: tuple[int, ...]
    logical_start: int
    logical_end: int
    text: str
    node_kind: str
    editable: bool
    read_only_reason: str | None = None
    hyperlink_key: str | None = None
    content_control_key: str | None = None
    tracked_insert_key: str | None = None
    role: str = "ordinary"


@dataclass
class DocumentTextSegment:
    segment_id: str
    document_id: str
    version_id: str
    part_path: str
    structure_type: str
    text: str
    normalized_text: str
    node_path: tuple[int, ...]
    location: dict
    spans: list[TextNodeSpan]
    searchable_by_default: bool = True
    element_id: str | None = None
    revision_id: str | None = None

    @property
    def editable(self) -> bool:
        return any(span.editable and span.logical_end > span.logical_start for span in self.spans)

    @property
    def protected_ranges(self) -> list[dict]:
        return [
            {
                "start": span.logical_start,
                "end": span.logical_end,
                "reason": span.read_only_reason,
                "role": span.role,
            }
            for span in self.spans
            if not span.editable and span.logical_end > span.logical_start
        ]

    def editability_for_range(self, start: int, end: int) -> tuple[bool, str | None]:
        if start < 0 or end <= start or end > len(self.text):
            return False, "The selected occurrence is outside its logical text segment."
        intersecting = [
            span
            for span in self.spans
            if span.logical_start < end and span.logical_end > start
        ]
        if not intersecting:
            return False, "The selected occurrence cannot be mapped back to OOXML text nodes."
        protected = next((span for span in intersecting if not span.editable), None)
        if protected is not None:
            return False, protected.read_only_reason or (
                "This text is inside a structure that DocSync can detect but cannot "
                "safely modify yet."
            )

        for attribute, reason in (
            ("hyperlink_key", PROTECTED_HYPERLINK_BOUNDARY),
            ("content_control_key", PROTECTED_CONTROL_BOUNDARY),
            ("tracked_insert_key", PROTECTED_REVISION_BOUNDARY),
        ):
            values = {getattr(span, attribute) for span in intersecting}
            if len(values) > 1 and any(value is not None for value in values):
                return False, reason
        return True, None

    def effective_structure_type(self, start: int, end: int) -> str:
        intersecting = [
            span
            for span in self.spans
            if span.logical_start < end and span.logical_end > start
        ]
        roles = {span.role for span in intersecting}
        if roles == {"field_result"}:
            return "field_result"
        if roles == {"tracked_insert"}:
            return "tracked_insert"
        if intersecting and all(span.hyperlink_key is not None for span in intersecting):
            return "hyperlink"
        if intersecting and all(
            span.content_control_key is not None for span in intersecting
        ):
            return "content_control"
        return self.structure_type

    def as_dict(self) -> dict:
        return {
            "segment_id": self.segment_id,
            "document_id": self.document_id,
            "version_id": self.version_id,
            "part": self.part_path,
            "part_path": self.part_path,
            "structure_type": self.structure_type,
            "text": self.text,
            "normalized_text": self.normalized_text,
            "location": self.location,
            "editable": self.editable,
            "read_only": not self.editable,
            "read_only_reason": (
                next(
                    (
                        span.read_only_reason
                        for span in self.spans
                        if span.read_only_reason
                    ),
                    None,
                )
                if not self.editable
                else None
            ),
            "protected_ranges": self.protected_ranges,
            "element_id": self.element_id,
            "revision_id": self.revision_id,
            "searchable_by_default": self.searchable_by_default,
        }


@dataclass(frozen=True)
class TextReplacementPatch:
    occurrence_id: str
    segment_id: str
    part_path: str
    match_start: int
    match_end: int
    expected_text: str
    replacement_text: str


@dataclass
class CompiledTextReplacementPlan:
    """Validated, deterministic node-local edits ready for OOXML write-back."""

    patch_count: int
    segment_count: int
    node_edits: dict[
        tuple[str, tuple[int, ...]],
        list[tuple[int, int, str, str]],
    ]


@dataclass
class DocumentTextInventory:
    document_id: str
    version_id: str
    package_sha256: str
    segments: list[DocumentTextSegment] = field(default_factory=list)

    @property
    def by_id(self) -> dict[str, DocumentTextSegment]:
        return {segment.segment_id: segment for segment in self.segments}

    def as_dict(self) -> dict:
        counts: dict[str, int] = {}
        for segment in self.segments:
            counts[segment.structure_type] = counts.get(segment.structure_type, 0) + 1
        return {
            "document_id": self.document_id,
            "version_id": self.version_id,
            "package_sha256": self.package_sha256,
            "segment_count": len(self.segments),
            "structure_counts": counts,
            "segments": [segment.as_dict() for segment in self.segments],
        }


@dataclass
class _ParsedPart:
    path: str
    root: etree._Element
    metadata: dict


def _read_source(source: Path | bytes) -> bytes:
    if isinstance(source, bytes):
        return source
    try:
        return source.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="The immutable DOCX file is missing.") from exc


def _parse_xml(payload: bytes, part_path: str) -> etree._Element:
    parser = etree.XMLParser(
        resolve_entities=False,
        remove_blank_text=False,
        no_network=True,
        recover=False,
    )
    try:
        return etree.fromstring(payload, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{part_path}: the Word XML part is malformed.",
        ) from exc


def _node_path(root: etree._Element, node: etree._Element) -> tuple[int, ...]:
    values: list[int] = []
    current = node
    while current is not root:
        parent = current.getparent()
        if parent is None:
            raise ValueError("The OOXML node is not attached to the parsed part root.")
        values.append(parent.index(current))
        current = parent
    return tuple(reversed(values))


def _resolve_node(root: etree._Element, path: tuple[int, ...]) -> etree._Element:
    current = root
    try:
        for index in path:
            current = current[index]
    except IndexError as exc:
        raise HTTPException(
            status_code=409,
            detail="The target OOXML location no longer exists. Re-scan the document.",
        ) from exc
    return current


def _nearest_ancestor(node: etree._Element, tag: str) -> etree._Element | None:
    current = node.getparent()
    while current is not None:
        if current.tag == tag:
            return current
        current = current.getparent()
    return None


def _nearest_paragraph(node: etree._Element) -> etree._Element | None:
    return _nearest_ancestor(node, W_P)


def _ancestor_key(
    root: etree._Element,
    node: etree._Element,
    tag: str,
    *,
    relationship: bool = False,
) -> str | None:
    ancestor = _nearest_ancestor(node, tag)
    if ancestor is None:
        return None
    if relationship:
        relationship_id = ancestor.get(_qname(REL_NS, "id")) or ancestor.get(
            _qname(WORD_NS, "anchor")
        )
        return relationship_id or "/".join(str(index) for index in _node_path(root, ancestor))
    return "/".join(str(index) for index in _node_path(root, ancestor))


def _sibling_index(node: etree._Element, tag: str) -> int:
    parent = node.getparent()
    if parent is None:
        return 0
    return sum(1 for sibling in parent[: parent.index(node)] if sibling.tag == tag)


def _descendant_paragraph_index(container: etree._Element, paragraph: etree._Element) -> int:
    paragraphs = []
    for candidate in container.iter(W_P):
        if _nearest_ancestor(candidate, W_TC) is not container and container.tag == W_TC:
            continue
        if _nearest_ancestor(candidate, W_TXBX_CONTENT) is not None:
            continue
        paragraphs.append(candidate)
    try:
        return paragraphs.index(paragraph)
    except ValueError:
        return 0


def _table_location(paragraph: etree._Element) -> dict | None:
    tables: list[etree._Element] = []
    current = paragraph.getparent()
    while current is not None:
        if current.tag == W_TBL:
            tables.append(current)
        current = current.getparent()
    if not tables:
        return None
    tables.reverse()

    path: list[dict] = []
    for table in tables:
        row = next(
            (
                ancestor
                for ancestor in paragraph.iterancestors()
                if ancestor.tag == W_TR and ancestor.getparent() is table
            ),
            None,
        )
        cell = next(
            (
                ancestor
                for ancestor in paragraph.iterancestors()
                if ancestor.tag == W_TC
                and row is not None
                and ancestor.getparent() is row
            ),
            None,
        )
        path.append(
            {
                "table_index": _sibling_index(table, W_TBL),
                "row_index": _sibling_index(row, W_TR) if row is not None else 0,
                "column_index": _sibling_index(cell, W_TC) if cell is not None else 0,
            }
        )

    cell = _nearest_ancestor(paragraph, W_TC)
    location = {
        "kind": "table_paragraph",
        **path[0],
        "paragraph_index": (
            _descendant_paragraph_index(cell, paragraph) if cell is not None else 0
        ),
        "nested_table_depth": len(path) - 1,
        "table_path": path,
    }
    return location


def _relationship_target(base_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(base_part), target))


def _header_footer_metadata(files: dict[str, bytes]) -> dict[str, dict]:
    document_payload = files.get("word/document.xml")
    relationships_payload = files.get("word/_rels/document.xml.rels")
    if document_payload is None or relationships_payload is None:
        return {}
    document_root = _parse_xml(document_payload, "word/document.xml")
    relationships_root = _parse_xml(
        relationships_payload,
        "word/_rels/document.xml.rels",
    )
    relationship_targets = {
        relationship.get("Id", ""): _relationship_target(
            "word/document.xml",
            relationship.get("Target", ""),
        )
        for relationship in relationships_root
        if relationship.get("Id") and relationship.get("Target")
    }
    active: dict[tuple[str, str], tuple[int, str, str]] = {}
    metadata: dict[str, dict] = {}
    section_properties = document_root.xpath("//w:sectPr", namespaces=NS)
    for section_index, section in enumerate(section_properties):
        for kind in ("header", "footer"):
            reference_tag = _qname(WORD_NS, f"{kind}Reference")
            direct_by_variant = {
                reference.get(_qname(WORD_NS, "type"), "default"): reference
                for reference in section
                if reference.tag == reference_tag
            }
            for variant in ("default", "first", "even"):
                key = (kind, variant)
                direct = direct_by_variant.get(variant)
                if direct is not None:
                    relationship_id = direct.get(_qname(REL_NS, "id"))
                    part_path = relationship_targets.get(relationship_id or "")
                    if relationship_id and part_path:
                        active[key] = (section_index, relationship_id, part_path)
                inherited = active.get(key)
                if inherited is None:
                    continue
                source_section_index, relationship_id, part_path = inherited
                entry = metadata.setdefault(
                    part_path,
                    {
                        "kind": kind,
                        "part_relationship_id": relationship_id,
                        "usages": [],
                    },
                )
                entry["usages"].append(
                    {
                        "section_index": section_index,
                        "source_section_index": source_section_index,
                        "variant": variant,
                        "header_footer_type": (
                            f"{'first_page' if variant == 'first' else 'even_page' if variant == 'even' else 'default'}_{kind}"
                        ),
                        "is_linked_to_previous": direct is None,
                    }
                )
    return metadata


def _part_metadata(path: str, header_footer: dict[str, dict]) -> dict:
    if path == "word/document.xml":
        return {"kind": "document"}
    if path == "word/footnotes.xml":
        return {"kind": "footnote"}
    if path == "word/endnotes.xml":
        return {"kind": "endnote"}
    if path == "word/comments.xml":
        return {"kind": "comment"}
    if path in header_footer:
        return dict(header_footer[path])
    if path.startswith("word/header"):
        return {"kind": "header", "usages": []}
    if path.startswith("word/footer"):
        return {"kind": "footer", "usages": []}
    return {"kind": "other"}


def _inventory_parts(files: dict[str, bytes]) -> list[_ParsedPart]:
    header_footer = _header_footer_metadata(files)
    candidates = {
        "word/document.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
        "word/comments.xml",
        *header_footer.keys(),
        *(
            path
            for path in files
            if path.startswith("word/header") and path.endswith(".xml")
        ),
        *(
            path
            for path in files
            if path.startswith("word/footer") and path.endswith(".xml")
        ),
        *(
            path
            for path in files
            if path.startswith("word/charts/") and path.endswith(".xml")
        ),
    }
    parts: list[_ParsedPart] = []
    for path in sorted(candidates):
        payload = files.get(path)
        if payload is None:
            continue
        parts.append(
            _ParsedPart(
                path=path,
                root=_parse_xml(payload, path),
                metadata=_part_metadata(path, header_footer),
            )
        )
    return parts


def _style_type(paragraph: etree._Element) -> str:
    style_nodes = paragraph.xpath("./w:pPr/w:pStyle/@w:val", namespaces=NS)
    style = str(style_nodes[0]).casefold() if style_nodes else ""
    if style.startswith(("heading", "title")):
        return "heading"
    if paragraph.xpath("./w:pPr/w:numPr", namespaces=NS) or style.startswith("list"):
        return "list_item"
    return "body_paragraph"


def _paragraph_location(
    part: _ParsedPart,
    paragraph: etree._Element,
    paragraph_number: int,
) -> tuple[str, dict]:
    text_box = _nearest_ancestor(paragraph, W_TXBX_CONTENT)
    table = _table_location(paragraph)
    if text_box is not None:
        return "text_box", {
            "kind": "text_box",
            "paragraph_index": paragraph_number,
            "text_box_path": list(_node_path(part.root, text_box)),
        }

    kind = str(part.metadata.get("kind") or "other")
    if kind == "footnote":
        note = _nearest_ancestor(paragraph, W_FOOTNOTE)
        return "footnote", {
            "kind": "footnote",
            "footnote_id": note.get(_qname(WORD_NS, "id")) if note is not None else None,
            "paragraph_index": paragraph_number,
        }
    if kind == "endnote":
        note = _nearest_ancestor(paragraph, W_ENDNOTE)
        return "endnote", {
            "kind": "endnote",
            "endnote_id": note.get(_qname(WORD_NS, "id")) if note is not None else None,
            "paragraph_index": paragraph_number,
        }
    if kind == "comment":
        comment = _nearest_ancestor(paragraph, W_COMMENT)
        return "comment", {
            "kind": "comment",
            "comment_id": comment.get(_qname(WORD_NS, "id")) if comment is not None else None,
            "paragraph_index": paragraph_number,
        }
    if table is not None:
        table["part_kind"] = kind
        return "table_paragraph", table
    if kind in {"header", "footer"}:
        usages = list(part.metadata.get("usages") or [])
        canonical = min(
            usages,
            key=lambda usage: (usage["section_index"], usage["variant"]),
            default={
                "section_index": 0,
                "source_section_index": 0,
                "variant": "default",
                "header_footer_type": f"default_{kind}",
                "is_linked_to_previous": False,
            },
        )
        return f"{kind}_paragraph", {
            "kind": f"{kind}_paragraph",
            "section_index": canonical["source_section_index"],
            "source_section_index": canonical["source_section_index"],
            "paragraph_index": paragraph_number,
            "part_relationship_id": part.metadata.get("part_relationship_id"),
            "header_footer_type": canonical["header_footer_type"],
            "section_indexes": sorted({usage["section_index"] for usage in usages}),
            "is_linked_to_previous": any(
                usage.get("is_linked_to_previous") for usage in usages
            ),
        }
    if _nearest_ancestor(paragraph, W_SDT_CONTENT) is not None:
        return "content_control", {
            "kind": "content_control",
            "paragraph_index": paragraph_number,
        }
    return _style_type(paragraph), {
        "kind": "body",
        "document_order": _sibling_index(paragraph, W_P),
        "paragraph_index": _sibling_index(paragraph, W_P),
    }


def _visible_atom_value(node: etree._Element) -> tuple[str, str, bool, str | None]:
    if node.tag == W_T:
        return node.text or "", "text", True, None
    if node.tag == W_TAB:
        return "\t", "tab", False, PROTECTED_SPECIAL_CHARACTER
    if node.tag in {W_BR, W_CR}:
        return "\n", "line_break", False, PROTECTED_SPECIAL_CHARACTER
    if node.tag == W_NO_BREAK_HYPHEN:
        return "\u2011", "no_break_hyphen", False, PROTECTED_SPECIAL_CHARACTER
    if node.tag == W_SOFT_HYPHEN:
        return "\u00ad", "soft_hyphen", False, PROTECTED_SPECIAL_CHARACTER
    if node.tag == W_SYM:
        raw_value = node.get(_qname(WORD_NS, "char"), "")
        try:
            value = chr(int(raw_value, 16))
        except ValueError:
            value = "�"
        return value, "symbol", False, PROTECTED_SPECIAL_CHARACTER
    return "", "unknown", False, PROTECTED_SPECIAL_CHARACTER


def _paragraph_segments(
    part: _ParsedPart,
    paragraph: etree._Element,
    paragraph_number: int,
    *,
    document_id: str,
    version_id: str,
) -> list[DocumentTextSegment]:
    structure_type, location = _paragraph_location(part, paragraph, paragraph_number)
    visible_values: list[str] = []
    visible_spans: list[TextNodeSpan] = []
    deleted_values: list[str] = []
    deleted_spans: list[TextNodeSpan] = []
    instruction_values: list[str] = []
    instruction_spans: list[TextNodeSpan] = []
    field_stack: list[str] = []

    for node in paragraph.iter():
        if node is not paragraph and _nearest_paragraph(node) is not paragraph:
            continue
        if node.tag == W_FLD_CHAR:
            field_type = node.get(_qname(WORD_NS, "fldCharType"), "")
            if field_type == "begin":
                field_stack.append("instruction")
            elif field_type == "separate" and field_stack:
                field_stack[-1] = "result"
            elif field_type == "end" and field_stack:
                field_stack.pop()
            continue
        if node.tag == W_INSTR_TEXT:
            value = node.text or ""
            start = sum(len(item) for item in instruction_values)
            instruction_values.append(value)
            instruction_spans.append(
                TextNodeSpan(
                    node_path=_node_path(part.root, node),
                    logical_start=start,
                    logical_end=start + len(value),
                    text=value,
                    node_kind="field_instruction",
                    editable=False,
                    read_only_reason=PROTECTED_FIELD_INSTRUCTION,
                    role="field_instruction",
                )
            )
            continue
        if node.tag == W_DEL_TEXT or (
            node.tag == W_T and _nearest_ancestor(node, W_DEL) is not None
        ):
            value = node.text or ""
            start = sum(len(item) for item in deleted_values)
            deleted_values.append(value)
            deleted_spans.append(
                TextNodeSpan(
                    node_path=_node_path(part.root, node),
                    logical_start=start,
                    logical_end=start + len(value),
                    text=value,
                    node_kind="tracked_deletion",
                    editable=False,
                    read_only_reason=PROTECTED_TRACKED_DELETION,
                    role="tracked_delete",
                )
            )
            continue
        if node.tag not in {
            W_T,
            W_TAB,
            W_BR,
            W_CR,
            W_NO_BREAK_HYPHEN,
            W_SOFT_HYPHEN,
            W_SYM,
        }:
            continue

        value, node_kind, editable, reason = _visible_atom_value(node)
        if not value:
            continue
        role = "ordinary"
        if field_stack and field_stack[-1] == "result":
            editable = False
            reason = PROTECTED_FIELD_RESULT
            role = "field_result"
        elif _nearest_ancestor(node, W_INS) is not None:
            role = "tracked_insert"
        start = sum(len(item) for item in visible_values)
        visible_values.append(value)
        visible_spans.append(
            TextNodeSpan(
                node_path=_node_path(part.root, node),
                logical_start=start,
                logical_end=start + len(value),
                text=value,
                node_kind=node_kind,
                editable=editable,
                read_only_reason=reason,
                hyperlink_key=_ancestor_key(
                    part.root,
                    node,
                    W_HYPERLINK,
                    relationship=True,
                ),
                content_control_key=_ancestor_key(part.root, node, W_SDT),
                tracked_insert_key=_ancestor_key(part.root, node, W_INS),
                role=role,
            )
        )

    segments: list[DocumentTextSegment] = []
    paragraph_path = _node_path(part.root, paragraph)

    def add_segment(
        segment_type: str,
        values: list[str],
        spans: list[TextNodeSpan],
        *,
        searchable_by_default: bool,
        suffix: str,
    ) -> None:
        text_value = "".join(values)
        if not text_value:
            return
        identity = (
            f"docsync:text-segment:{version_id}:{part.path}:"
            f"{'/'.join(str(index) for index in paragraph_path)}:{suffix}"
        )
        segments.append(
            DocumentTextSegment(
                segment_id=str(uuid5(NAMESPACE_URL, identity)),
                document_id=document_id,
                version_id=version_id,
                part_path=part.path,
                structure_type=segment_type,
                text=text_value,
                normalized_text=normalise_search_text(text_value),
                node_path=paragraph_path,
                location=dict(location),
                spans=spans,
                searchable_by_default=searchable_by_default,
            )
        )

    add_segment(
        structure_type,
        visible_values,
        visible_spans,
        searchable_by_default=structure_type != "comment",
        suffix="visible",
    )
    add_segment(
        "field_instruction",
        instruction_values,
        instruction_spans,
        searchable_by_default=False,
        suffix="field-instruction",
    )
    add_segment(
        "tracked_delete",
        deleted_values,
        deleted_spans,
        searchable_by_default=False,
        suffix="tracked-delete",
    )
    return segments


def _drawing_segments(
    part: _ParsedPart,
    *,
    document_id: str,
    version_id: str,
) -> list[DocumentTextSegment]:
    segments: list[DocumentTextSegment] = []
    for paragraph_number, drawing_paragraph in enumerate(part.root.iter(A_P)):
        if _nearest_ancestor(drawing_paragraph, W_TXBX_CONTENT) is not None:
            continue
        values: list[str] = []
        spans: list[TextNodeSpan] = []
        for node in drawing_paragraph.iter(A_T):
            value = node.text or ""
            if not value:
                continue
            start = sum(len(item) for item in values)
            values.append(value)
            spans.append(
                TextNodeSpan(
                    node_path=_node_path(part.root, node),
                    logical_start=start,
                    logical_end=start + len(value),
                    text=value,
                    node_kind="drawing_text",
                    editable=False,
                    read_only_reason=PROTECTED_DRAWING,
                    role="drawing_text",
                )
            )
        text_value = "".join(values)
        if not text_value:
            continue
        path = _node_path(part.root, drawing_paragraph)
        identity = (
            f"docsync:text-segment:{version_id}:{part.path}:"
            f"{'/'.join(str(index) for index in path)}:drawing"
        )
        segments.append(
            DocumentTextSegment(
                segment_id=str(uuid5(NAMESPACE_URL, identity)),
                document_id=document_id,
                version_id=version_id,
                part_path=part.path,
                structure_type="drawing_text",
                text=text_value,
                normalized_text=normalise_search_text(text_value),
                node_path=path,
                location={
                    "kind": "drawing_text",
                    "drawing_paragraph_index": paragraph_number,
                },
                spans=spans,
                searchable_by_default=True,
            )
        )
    return segments


def build_text_inventory(
    source: Path | bytes,
    *,
    document_id: str,
    version_id: str,
) -> DocumentTextInventory:
    payload = _read_source(source)
    try:
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            files = {
                item.filename: archive.read(item)
                for item in archive.infolist()
                if not item.is_dir()
            }
    except (zipfile.BadZipFile, OSError) as exc:
        raise HTTPException(status_code=422, detail="The immutable DOCX package is invalid.") from exc
    if "word/document.xml" not in files:
        raise HTTPException(status_code=422, detail="The DOCX package has no main document XML part.")

    inventory = DocumentTextInventory(
        document_id=document_id,
        version_id=version_id,
        package_sha256=hashlib.sha256(payload).hexdigest(),
    )
    for part in _inventory_parts(files):
        for paragraph_number, paragraph in enumerate(part.root.iter(W_P)):
            inventory.segments.extend(
                _paragraph_segments(
                    part,
                    paragraph,
                    paragraph_number,
                    document_id=document_id,
                    version_id=version_id,
                )
            )
        inventory.segments.extend(
            _drawing_segments(
                part,
                document_id=document_id,
                version_id=version_id,
            )
        )
    return inventory


def _normalisation_clusters(text: str) -> list[tuple[int, int, str]]:
    clusters: list[tuple[int, int, str]] = []
    start = 0
    for index, character in enumerate(text):
        if index > start and unicodedata.combining(character) == 0:
            clusters.append((start, index, text[start:index]))
            start = index
    if text:
        clusters.append((start, len(text), text[start:]))
    return clusters


def normalised_text_with_offsets(
    text: str,
    *,
    match_case: bool = False,
) -> tuple[str, list[int], list[int]]:
    characters: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for source_start, source_end, cluster in _normalisation_clusters(text):
        fragment = unicodedata.normalize("NFKC", cluster)
        if not match_case:
            fragment = fragment.casefold()
        for character in fragment:
            if character.isspace():
                if not characters:
                    continue
                if characters[-1] == " ":
                    ends[-1] = source_end
                    continue
                character = " "
            characters.append(character)
            starts.append(source_start)
            ends.append(source_end)
    if characters and characters[-1] == " ":
        characters.pop()
        starts.pop()
        ends.pop()
    return "".join(characters), starts, ends


def normalise_search_text(text: str, *, match_case: bool = False) -> str:
    return normalised_text_with_offsets(text, match_case=match_case)[0]


def _is_word_character(character: str) -> bool:
    if character == "_" or character.isalnum():
        return True
    return bool(character and unicodedata.category(character).startswith("M"))


def find_occurrence_ranges(
    text: str,
    query: str,
    *,
    match_case: bool = False,
    whole_word: bool = False,
) -> list[tuple[int, int]]:
    normalized_text, starts, ends = normalised_text_with_offsets(
        text,
        match_case=match_case,
    )
    normalized_query = normalise_search_text(query, match_case=match_case)
    if not normalized_text or not normalized_query:
        return []
    results: list[tuple[int, int]] = []
    cursor = 0
    while cursor <= len(normalized_text) - len(normalized_query):
        normalized_start = normalized_text.find(normalized_query, cursor)
        if normalized_start < 0:
            break
        normalized_end = normalized_start + len(normalized_query)
        if whole_word:
            before = normalized_text[normalized_start - 1] if normalized_start else ""
            after = (
                normalized_text[normalized_end]
                if normalized_end < len(normalized_text)
                else ""
            )
            if _is_word_character(before) or _is_word_character(after):
                cursor = normalized_start + 1
                continue
        results.append((starts[normalized_start], ends[normalized_end - 1]))
        cursor = normalized_end
    return results


def occurrence_context(
    text: str,
    start: int,
    end: int,
    *,
    radius: int = 72,
) -> tuple[str, str, str]:
    context_start = max(0, start - radius)
    context_end = min(len(text), end + radius)
    before = text[context_start:start]
    after = text[end:context_end]
    if context_start:
        before = f"…{before}"
    if context_end < len(text):
        after = f"{after}…"
    return before, text[start:end], after


def occurrence_id(
    segment: DocumentTextSegment,
    start: int,
    end: int,
) -> str:
    value = (
        f"docsync:text-occurrence:{segment.version_id}:{segment.segment_id}:"
        f"{start}:{end}:{segment.text[start:end]}"
    )
    return str(uuid5(NAMESPACE_URL, value))


def _serialize_xml(root: etree._Element) -> bytes:
    return etree.tostring(
        root,
        encoding="UTF-8",
        xml_declaration=True,
        standalone=True,
    )


def compile_text_replacement_plan(
    inventory: DocumentTextInventory,
    patches: list[TextReplacementPatch],
) -> CompiledTextReplacementPlan:
    by_segment = inventory.by_id
    node_edits: dict[tuple[str, tuple[int, ...]], list[tuple[int, int, str, str]]] = {}
    logical_ranges: dict[str, list[tuple[int, int, str]]] = {}

    for patch in patches:
        segment = by_segment.get(patch.segment_id)
        if segment is None or segment.part_path != patch.part_path:
            raise HTTPException(
                status_code=409,
                detail="A selected text segment no longer exists. Re-scan required.",
            )
        if segment.text[patch.match_start : patch.match_end] != patch.expected_text:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The target text no longer matches the version used to build this "
                    "change. Re-scan required."
                ),
            )
        editable, reason = segment.editability_for_range(
            patch.match_start,
            patch.match_end,
        )
        if not editable:
            raise HTTPException(status_code=422, detail=reason)
        ranges = logical_ranges.setdefault(segment.segment_id, [])
        for existing_start, existing_end, existing_id in ranges:
            if patch.match_start < existing_end and patch.match_end > existing_start:
                if (
                    patch.match_start == existing_start
                    and patch.match_end == existing_end
                    and patch.occurrence_id == existing_id
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="The same occurrence was selected more than once.",
                    )
                raise HTTPException(
                    status_code=409,
                    detail="Two pending edits overlap in the same logical text segment.",
                )
        ranges.append((patch.match_start, patch.match_end, patch.occurrence_id))

        intersecting = [
            span
            for span in segment.spans
            if span.logical_start < patch.match_end
            and span.logical_end > patch.match_start
        ]
        for index, span in enumerate(intersecting):
            local_start = max(patch.match_start, span.logical_start) - span.logical_start
            local_end = min(patch.match_end, span.logical_end) - span.logical_start
            replacement = patch.replacement_text if index == 0 else ""
            node_edits.setdefault((segment.part_path, span.node_path), []).append(
                (local_start, local_end, replacement, patch.occurrence_id)
            )

    return CompiledTextReplacementPlan(
        patch_count=len(patches),
        segment_count=len(logical_ranges),
        node_edits=node_edits,
    )


def apply_text_replacements(
    source: Path | bytes,
    inventory: DocumentTextInventory,
    patches: list[TextReplacementPatch],
) -> bytes:
    payload = _read_source(source)
    if hashlib.sha256(payload).hexdigest() != inventory.package_sha256:
        raise HTTPException(
            status_code=409,
            detail="The document changed after the search was performed. Re-scan required.",
        )
    plan = compile_text_replacement_plan(inventory, patches)
    node_edits = plan.node_edits

    try:
        with zipfile.ZipFile(BytesIO(payload)) as source_archive:
            infos = source_archive.infolist()
            files = {
                info.filename: source_archive.read(info)
                for info in infos
                if not info.is_dir()
            }
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=422, detail="The immutable DOCX package is invalid.") from exc

    roots: dict[str, etree._Element] = {}
    for part_path, _node_path_value in node_edits:
        if part_path not in roots:
            part_payload = files.get(part_path)
            if part_payload is None:
                raise HTTPException(
                    status_code=409,
                    detail="A target Word XML part is no longer present. Re-scan required.",
                )
            roots[part_path] = _parse_xml(part_payload, part_path)

    for (part_path, node_path_value), edits in node_edits.items():
        node = _resolve_node(roots[part_path], node_path_value)
        original = node.text or ""
        ordered = sorted(edits, key=lambda item: (item[0], item[1]), reverse=True)
        last_start = len(original) + 1
        current = original
        for start, end, replacement, _occurrence in ordered:
            if start < 0 or end < start or end > len(original):
                raise HTTPException(
                    status_code=409,
                    detail="A selected OOXML text range is no longer valid. Re-scan required.",
                )
            if end > last_start:
                raise HTTPException(
                    status_code=409,
                    detail="Two pending edits overlap inside the same Word run.",
                )
            current = current[:start] + replacement + current[end:]
            last_start = start
        node.text = current
        if node.tag in {W_T, W_DEL_TEXT, W_INSTR_TEXT} and (
            current.startswith(" ") or current.endswith(" ")
        ):
            node.set(_qname(XML_NS, "space"), "preserve")

    modified_files = {path: _serialize_xml(root) for path, root in roots.items()}
    output = BytesIO()
    with zipfile.ZipFile(output, mode="w") as target_archive:
        with zipfile.ZipFile(BytesIO(payload)) as source_archive:
            for info in source_archive.infolist():
                if info.is_dir():
                    target_archive.writestr(info, b"")
                    continue
                target_archive.writestr(
                    info,
                    modified_files.get(info.filename, source_archive.read(info)),
                )
    result = output.getvalue()
    try:
        with zipfile.ZipFile(BytesIO(result)) as validation_archive:
            if "word/document.xml" not in validation_archive.namelist():
                raise zipfile.BadZipFile("missing word/document.xml")
            for part_path in modified_files:
                _parse_xml(validation_archive.read(part_path), part_path)
    except (zipfile.BadZipFile, KeyError) as exc:
        raise HTTPException(
            status_code=500,
            detail="The edited DOCX package failed OOXML validation and was not saved.",
        ) from exc
    return result
