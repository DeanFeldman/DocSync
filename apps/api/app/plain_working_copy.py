"""Make cached cross-reference values editable in the original DOCX layout."""

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import PurePosixPath
from zipfile import ZipFile

from docx.oxml.ns import qn
from lxml import etree


FIELD = qn("w:fldChar")
FIELD_TYPE = qn("w:fldCharType")
SIMPLE_FIELD = qn("w:fldSimple")
INSTRUCTION = qn("w:instrText")
TEXT = qn("w:t")
CROSS_REFERENCES = {"REF", "PAGEREF", "NOTEREF"}


def _is_cross_reference(instruction: str) -> bool:
    tokens = instruction.split(maxsplit=1)
    return bool(tokens and tokens[0].upper() in CROSS_REFERENCES)


@dataclass
class _ComplexField:
    markers: list[etree._Element]
    instructions: list[etree._Element] = field(default_factory=list)
    after_separator: bool = False
    has_text: bool = False


def _cross_reference_nodes(root: etree._Element) -> list[etree._Element]:
    """Find only complete complex fields with a saved text result."""
    stack: list[_ComplexField] = []
    removable: list[etree._Element] = []
    for node in root.iter(FIELD, INSTRUCTION, TEXT):
        if node.tag == FIELD and node.get(FIELD_TYPE) == "begin":
            stack.append(_ComplexField([node]))
        elif stack:
            current = stack[-1]
            if node.tag == FIELD and node.get(FIELD_TYPE) == "separate":
                current.markers.append(node)
                current.after_separator = True
            elif node.tag == FIELD and node.get(FIELD_TYPE) == "end":
                stack.pop()
                instruction = "".join(part.text or "" for part in current.instructions)
                if current.has_text and _is_cross_reference(instruction):
                    removable.extend([*current.markers, *current.instructions, node])
            elif node.tag == INSTRUCTION and not current.after_separator:
                current.instructions.append(node)
            elif node.tag == TEXT and current.after_separator and node.text:
                current.has_text = True
    return removable


def _transform_part(payload: bytes) -> bytes:
    root = etree.fromstring(payload, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    removable = _cross_reference_nodes(root)
    simple = [
        node for node in root.iter(SIMPLE_FIELD)
        if _is_cross_reference(node.get(qn("w:instr"), ""))
        and any(result.text for result in node.iter(TEXT))
    ]
    if not removable and not simple:
        return payload

    for node in removable:
        node.getparent().remove(node)
    for node in simple:
        parent = node.getparent()
        index = parent.index(node)
        parent[index:index + 1] = list(node)

    return etree.tostring(root.getroottree(), encoding="UTF-8", xml_declaration=True)


def create_plain_working_copy(payload: bytes) -> bytes:
    """Preserve all package parts and unwrap only cached cross-reference fields."""
    updates: dict[str, bytes] = {}
    with ZipFile(BytesIO(payload)) as source:
        for info in source.infolist():
            path = PurePosixPath(info.filename)
            if not path.parts or path.parts[0] != "word" or path.suffix != ".xml":
                continue
            part = source.read(info)
            if b"fldChar" not in part and b"fldSimple" not in part:
                continue
            updated = _transform_part(part)
            if updated is not part:
                updates[info.filename] = updated

        if not updates:
            return payload

        output = BytesIO()
        with ZipFile(output, "w") as target:
            target.comment = source.comment
            for info in source.infolist():
                part = updates.get(info.filename)
                target.writestr(info, source.read(info) if part is None else part)
    return output.getvalue()
