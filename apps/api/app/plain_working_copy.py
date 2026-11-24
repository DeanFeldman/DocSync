"""Build a Word working copy whose document content consists of plain text."""

from collections import defaultdict
from io import BytesIO
import re
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

from .text_inventory_service import build_text_inventory


PARAGRAPH = qn("w:p")
VALUE = qn("w:val")
LIST_TOKEN = re.compile(r"%([1-9])")


def _child(element, name: str):
    return element.find(qn(f"w:{name}")) if element is not None else None


def _value(element, name: str, default=None):
    child = _child(element, name)
    return child.get(VALUE, default) if child is not None else default


def _children(element, name: str):
    return element.findall(qn(f"w:{name}")) if element is not None else ()


def _xml(archive: ZipFile, part: str):
    try:
        payload = archive.read(part)
    except KeyError:
        return None
    return etree.fromstring(payload, parser=etree.XMLParser(resolve_entities=False, no_network=True))


def _letter(number: int) -> str:
    if number < 1:
        return str(number)
    result = ""
    while number:
        number, index = divmod(number - 1, 26)
        result = chr(ord("A") + index) + result
    return result


def _roman(number: int) -> str:
    if not 0 < number < 4000:
        return str(number)
    result = []
    for value, symbol in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
                          (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
                          (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        count, number = divmod(number, value)
        result.append(symbol * count)
    return "".join(result)


def _format_number(number: int, format_name: str) -> str:
    if format_name in {"upperLetter", "lowerLetter"}:
        text = _letter(number)
        return text.lower() if format_name == "lowerLetter" else text
    if format_name in {"upperRoman", "lowerRoman"}:
        text = _roman(number)
        return text.lower() if format_name == "lowerRoman" else text
    if format_name == "decimalZero":
        return f"{number:02d}"
    return str(number)


class WordListLabels:
    """Resolve common literal, decimal, alphabetic and Roman list labels."""

    def __init__(self, numbering, styles):
        self.abstract_levels = {
            item.get(qn("w:abstractNumId")): {
                int(level.get(qn("w:ilvl"), "0")): level
                for level in _children(item, "lvl")
            }
            for item in _children(numbering, "abstractNum")
        }
        self.lists = {item.get(qn("w:numId")): item for item in _children(numbering, "num")}
        self.styles = {item.get(qn("w:styleId")): item for item in _children(styles, "style")}

    def _paragraph_numbering(self, paragraph):
        props = _child(paragraph, "pPr")
        num = _child(props, "numPr")
        num_id = _value(num, "numId")
        level = _value(num, "ilvl")
        visited = set()
        style_id = _value(props, "pStyle")
        while num_id is None and style_id and style_id not in visited:
            visited.add(style_id)
            style = self.styles.get(style_id)
            num = _child(_child(style, "pPr"), "numPr")
            num_id = _value(num, "numId")
            if level is None:
                level = _value(num, "ilvl")
            style_id = _value(style, "basedOn")
        return num_id, int(level or "0")

    def _level(self, num, depth):
        abstract = self.abstract_levels.get(_value(num, "abstractNumId"), {})
        level = abstract.get(depth)
        override = next(
            (item for item in _children(num, "lvlOverride")
             if item.get(qn("w:ilvl")) == str(depth)), None,
        )
        override_level = _child(override, "lvl")
        if override_level is not None:
            level = override_level
        start = int(_value(override, "startOverride", _value(level, "start", "1")))
        return level, start

    def labels_for_story(self, root) -> dict:
        counters = defaultdict(dict)
        labels = {}
        for paragraph in root.iter(PARAGRAPH):
            num_id, depth = self._paragraph_numbering(paragraph)
            num = self.lists.get(num_id)
            if num is None:
                continue
            level, start = self._level(num, depth)
            template = _value(level, "lvlText", "")
            if not template or _value(level, "numFmt") == "none":
                continue
            state = counters[num_id]
            state[depth] = state.get(depth, start - 1) + 1
            for lower in tuple(state):
                if lower <= depth:
                    continue
                lower_level, _ = self._level(num, lower)
                restart_after = int(_value(lower_level, "lvlRestart", str(lower)))
                if restart_after and depth <= restart_after - 1:
                    del state[lower]

            def substitute(match):
                number_depth = int(match[1]) - 1
                number_level, number_start = self._level(num, number_depth)
                format_name = _value(number_level, "numFmt", "decimal")
                if _child(level, "isLgl") is not None:
                    format_name = "decimal"
                return _format_number(state.get(number_depth, number_start), format_name)

            label = LIST_TOKEN.sub(substitute, template)
            if _value(level, "numFmt") == "bullet" and any(0xE000 <= ord(c) <= 0xF8FF for c in label):
                label = "•"
            labels[_node_path(root, paragraph)] = label
        return labels


def _node_path(root, node) -> tuple[int, ...]:
    path = []
    while node is not root:
        parent = node.getparent()
        path.append(parent.index(node))
        node = parent
    return tuple(reversed(path))


def create_plain_working_copy(payload: bytes) -> bytes:
    inventory = build_text_inventory(payload, document_id="import", version_id="original")
    visible = [
        item for item in inventory.segments
        if item.structure_type not in {"field_instruction", "tracked_delete"}
    ]
    labels_by_part = {}
    with ZipFile(BytesIO(payload)) as archive:
        numbering = WordListLabels(_xml(archive, "word/numbering.xml"), _xml(archive, "word/styles.xml"))
        for part in dict.fromkeys(item.part_path for item in visible):
            root = _xml(archive, part)
            if root is not None:
                labels_by_part[part] = numbering.labels_for_story(root)

    working = Document()
    for item in visible:
        label = labels_by_part.get(item.part_path, {}).get(item.node_path)
        value = f"{label} {item.text}" if label else item.text
        if value.strip():
            working.add_paragraph(value)
    if not working.paragraphs:
        working.add_paragraph()
    output = BytesIO()
    working.save(output)
    return output.getvalue()
