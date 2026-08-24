from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import threading
from time import perf_counter
import unicodedata
from uuid import uuid4

import pymupdf
from fastapi import HTTPException
from sqlalchemy.orm import Session

from .config import settings
from .models import DocumentBlockRevision, DocumentVersion


logger = logging.getLogger(__name__)

RENDER_MAP_SCHEMA_VERSION = 4
RENDER_MAP_ENGINE = "docsync-contextual-pdf-map-v4-empty-table-fields"
WORD_RENDER_ENGINE = "Microsoft Word ExportAsFixedFormat PDF"
TOKEN_PATTERN = re.compile(r"\w+", re.UNICODE)
RENDER_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
RENDER_MAP_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="docsync-render-map",
)
RENDER_MAP_LOCK = threading.RLock()
ACTIVE_RENDER_MAPS: set[str] = set()
RENDER_MAP_EVENTS: dict[str, threading.Event] = {}
PAGE_RENDER_LOCKS = tuple(threading.Lock() for _ in range(32))


@dataclass(frozen=True)
class _RenderContext:
    version_id: str
    document_id: str
    document_set_id: str
    source_path: Path
    source_sha256: str
    pdf_path: Path
    pdf_size: int
    pdf_mtime_ns: int
    cache_path: Path
    blocks: tuple[dict, ...]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalise_tokens(value: str) -> tuple[str, ...]:
    normalised = unicodedata.normalize("NFKC", value).casefold()
    return tuple(match.group(0) for match in TOKEN_PATTERN.finditer(normalised))


def _cache_path(document_set_id: str, version_id: str) -> Path:
    return settings.data_dir / "renders" / document_set_id / f"{version_id}.render-map.json"


def _pdf_path(document_set_id: str, version_id: str) -> Path:
    return settings.data_dir / "renders" / document_set_id / f"{version_id}.pdf"


def _source_path(version: DocumentVersion) -> Path:
    roots = {
        "originals": settings.data_dir / "originals",
        "generated": settings.data_dir / "generated",
    }
    root = roots.get(version.storage_area)
    if root is None:
        raise HTTPException(status_code=500, detail="Document version storage is invalid.")
    path = (root / version.storage_name).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Document version storage is invalid.") from exc
    if not path.is_file():
        raise HTTPException(status_code=500, detail="The document version file is missing.")
    return path


def _serialise_block(block: DocumentBlockRevision) -> dict:
    return {
        "element_id": block.element_id,
        "ordinal": block.ordinal,
        "element_type": block.element_type,
        "text": block.text,
        "location": dict(block.location_json or {}),
        "supported": bool(block.supported),
        "unsupported_reason": block.unsupported_reason,
    }


def _context_for_version(version: DocumentVersion) -> _RenderContext | None:
    document = version.document
    pdf_path = _pdf_path(document.document_set_id, version.id)
    if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
        return None
    source_path = _source_path(version)
    pdf_stat = pdf_path.stat()
    return _RenderContext(
        version_id=version.id,
        document_id=version.document_id,
        document_set_id=document.document_set_id,
        source_path=source_path,
        source_sha256=version.checksum_sha256 or _sha256_file(source_path),
        pdf_path=pdf_path,
        pdf_size=pdf_stat.st_size,
        pdf_mtime_ns=pdf_stat.st_mtime_ns,
        cache_path=_cache_path(document.document_set_id, version.id),
        blocks=tuple(_serialise_block(block) for block in version.blocks),
    )


def _read_cache(path: Path) -> dict | None:
    with RENDER_MAP_LOCK:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
    return payload if isinstance(payload, dict) else None


def _write_cache(path: Path, payload: dict) -> None:
    with RENDER_MAP_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def _cache_matches(payload: dict | None, context: _RenderContext) -> bool:
    return bool(
        payload
        and payload.get("schema_version") == RENDER_MAP_SCHEMA_VERSION
        and payload.get("version_id") == context.version_id
        and payload.get("document_id") == context.document_id
        and payload.get("source_sha256") == context.source_sha256
        and payload.get("pdf_size") == context.pdf_size
        and payload.get("pdf_mtime_ns") == context.pdf_mtime_ns
        and payload.get("map_engine") == RENDER_MAP_ENGINE
        and payload.get("mapper_version") == pymupdf.__version__
        and payload.get("render_dpi") == settings.render_map_dpi
    )


def _status_payload(context: _RenderContext, status: str, detail: str) -> dict:
    return {
        "schema_version": RENDER_MAP_SCHEMA_VERSION,
        "version_id": context.version_id,
        "document_id": context.document_id,
        "document_set_id": context.document_set_id,
        "status": status,
        "status_detail": detail,
        "map_engine": RENDER_MAP_ENGINE,
        "mapper": "PyMuPDF",
        "mapper_version": pymupdf.__version__,
        "render_dpi": settings.render_map_dpi,
        "pdf_engine": WORD_RENDER_ENGINE,
        "coordinate_unit": "normalised",
        "source_sha256": context.source_sha256,
        "pdf_sha256": None,
        "pdf_size": context.pdf_size,
        "pdf_mtime_ns": context.pdf_mtime_ns,
        "interactive_threshold": settings.render_map_confidence_threshold,
        "render_id": None,
        "render_version": None,
        "page_count": 0,
        "pages": [],
        "regions": [],
        "mapped_element_count": 0,
        "interactive_element_count": 0,
        "total_element_count": len(context.blocks),
        "unmapped": [],
        "generated_at": None,
    }


def _public_payload(payload: dict) -> dict:
    return {
        key: value
        for key, value in payload.items()
        if key not in {"pdf_size", "pdf_mtime_ns", "error"}
    }


def request_render_map(session: Session, version_id: str) -> dict:
    from .editor_service import get_version_or_404

    version = get_version_or_404(session, version_id)
    context = _context_for_version(version)
    if context is None:
        return {
            "schema_version": RENDER_MAP_SCHEMA_VERSION,
            "version_id": version.id,
            "document_id": version.document_id,
            "document_set_id": version.document.document_set_id,
            "status": "not_requested",
            "status_detail": "Load the Word preview to create selectable areas.",
            "map_engine": RENDER_MAP_ENGINE,
            "mapper": "PyMuPDF",
            "mapper_version": pymupdf.__version__,
            "render_dpi": settings.render_map_dpi,
            "pdf_engine": WORD_RENDER_ENGINE,
            "coordinate_unit": "normalised",
            "source_sha256": version.checksum_sha256,
            "pdf_sha256": None,
            "interactive_threshold": settings.render_map_confidence_threshold,
            "render_id": None,
            "render_version": None,
            "page_count": 0,
            "pages": [],
            "regions": [],
            "mapped_element_count": 0,
            "interactive_element_count": 0,
            "total_element_count": len(version.blocks),
            "unmapped": [],
            "generated_at": None,
        }

    cached = _read_cache(context.cache_path)
    if _cache_matches(cached, context) and cached.get("status") in {
        "completed",
        "partial",
        "failed",
    }:
        with RENDER_MAP_LOCK:
            RENDER_MAP_EVENTS.setdefault(
                f"{context.document_set_id}:{context.version_id}",
                threading.Event(),
            ).set()
        return _public_payload(cached)

    key = f"{context.document_set_id}:{context.version_id}"
    with RENDER_MAP_LOCK:
        cached = _read_cache(context.cache_path)
        if key in ACTIVE_RENDER_MAPS and _cache_matches(cached, context):
            return _public_payload(cached)
        ACTIVE_RENDER_MAPS.add(key)
        RENDER_MAP_EVENTS.setdefault(key, threading.Event()).clear()
        queued = _status_payload(
            context,
            "queued",
            "The PDF is ready. Page images and selectable text are queued.",
        )
        _write_cache(context.cache_path, queued)
        RENDER_MAP_EXECUTOR.submit(_generate_render_map, context, key)
    return _public_payload(queued)


def wait_for_render_map(
    session: Session,
    version_id: str,
    *,
    timeout: float = 180,
) -> dict:
    """Wait without repeatedly querying or writing SQLite render-job state."""

    payload = request_render_map(session, version_id)
    if payload.get("status") in {"completed", "partial", "failed"}:
        return payload
    key = f"{payload.get('document_set_id')}:{version_id}"
    with RENDER_MAP_LOCK:
        completion = RENDER_MAP_EVENTS.setdefault(key, threading.Event())
    completion.wait(timeout=max(0, timeout))
    session.expire_all()
    return request_render_map(session, version_id)


def _candidate_context(block: dict, tokens: list[dict], start: int, end: int) -> bool:
    first = tokens[start]
    last = tokens[end - 1]
    element_type = block["element_type"]
    location = block["location"]
    y = (first["y0"] + last["y1"]) / 2 / first["page_height"]
    page_number = first["page_number"]
    if element_type == "header_paragraph":
        if y > 0.28:
            return False
    elif element_type == "footer_paragraph":
        if y < 0.72:
            return False
    elif y < 0.055 or y > 0.955:
        return False

    header_footer_type = str(location.get("header_footer_type") or "")
    if header_footer_type.startswith("first_page_"):
        return page_number == 1
    if header_footer_type.startswith("even_page_"):
        return page_number % 2 == 0
    return True


def _line_key(token: dict) -> tuple[int, int, int]:
    return (
        int(token["page_number"]),
        int(token["block_number"]),
        int(token["line_number"]),
    )


def _same_line_affixes(
    tokens: list[dict],
    start: int,
    end: int,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    first_line = _line_key(tokens[start])
    last_line = _line_key(tokens[end - 1])
    prefix: list[str] = []
    cursor = start - 1
    while cursor >= 0 and _line_key(tokens[cursor]) == first_line:
        prefix.append(str(tokens[cursor]["value"]))
        cursor -= 1
    prefix.reverse()

    suffix: list[str] = []
    cursor = end
    while cursor < len(tokens) and _line_key(tokens[cursor]) == last_line:
        suffix.append(str(tokens[cursor]["value"]))
        cursor += 1
    return tuple(prefix), tuple(suffix)


def _safe_decorative_affixes(
    block: dict,
    prefix: tuple[str, ...],
    suffix: tuple[str, ...],
) -> bool:
    """Allow Word-rendered numbering and TOC page numbers, not arbitrary substrings.

    Automatic list/legal numbering is visible in Word/PDF but absent from the
    paragraph's OOXML text stream. TOC fields can similarly render a leading
    entry number and a trailing page number around the stored display text.
    These are safe coordinate decorations because they contain only bounded
    marker tokens. Ordinary surrounding words still reject the candidate.
    """

    if prefix:
        numeric_prefix = len(prefix) <= 4 and all(
            value.isdecimal() for value in prefix
        )
        list_prefix = (
            block.get("element_type") == "list_item"
            and len(prefix) == 1
            and (
                (len(prefix[0]) == 1 and prefix[0].isalpha())
                or bool(re.fullmatch(r"[ivxlcdm]+", prefix[0]))
            )
        )
        if not numeric_prefix and not list_prefix:
            return False
    if suffix and not (
        len(suffix) <= 2 and all(value.isdecimal() for value in suffix)
    ):
        return False
    return True


def _find_candidates(
    block: dict,
    tokens: list[dict],
    by_value: dict[str, list[int]],
) -> list[tuple[int, int]]:
    wanted = _normalise_tokens(block["text"])
    if not wanted:
        return []
    candidates: list[tuple[int, int]] = []
    for start in by_value.get(wanted[0], []):
        end = start + len(wanted)
        if end > len(tokens):
            continue
        if tuple(token["value"] for token in tokens[start:end]) != wanted:
            continue
        prefix, suffix = _same_line_affixes(tokens, start, end)
        if not _safe_decorative_affixes(block, prefix, suffix):
            continue
        if _candidate_context(block, tokens, start, end):
            candidates.append((start, end))
    return candidates


def _group_key(block: dict) -> tuple:
    element_type = block["element_type"]
    context = (
        "header"
        if element_type == "header_paragraph"
        else "footer"
        if element_type == "footer_paragraph"
        else element_type
    )
    return (
        _normalise_tokens(block["text"]),
        context,
        str(block["location"].get("header_footer_type") or ""),
    )


def _match_blocks(
    blocks: tuple[dict, ...],
    tokens: list[dict],
) -> tuple[dict[str, dict], list[dict]]:
    by_value: dict[str, list[int]] = {}
    for index, token in enumerate(tokens):
        by_value.setdefault(token["value"], []).append(index)
    grouped: dict[tuple, list[dict]] = {}
    for block in blocks:
        grouped.setdefault(_group_key(block), []).append(block)

    matches: dict[str, dict] = {}
    candidates_by_element_id: dict[str, list[tuple[int, int]]] = {}
    for group_blocks in sorted(grouped.values(), key=lambda items: items[0]["ordinal"]):
        ordered = sorted(group_blocks, key=lambda item: item["ordinal"])
        candidates = _find_candidates(ordered[0], tokens, by_value)
        for block in ordered:
            candidates_by_element_id[block["element_id"]] = candidates
        is_header_footer = ordered[0]["element_type"] in {
            "header_paragraph",
            "footer_paragraph",
        }
        assignments: list[tuple[dict, list[tuple[int, int]], float]] = []
        if is_header_footer and len(ordered) == 1 and candidates:
            assignments.append((ordered[0], candidates, 0.97))
        elif len(ordered) == 1 and len(candidates) == 1:
            assignments.append((ordered[0], [candidates[0]], 0.99))
        elif len(ordered) == len(candidates) and candidates:
            assignments.extend(
                (block, [candidate], 0.95)
                for block, candidate in zip(ordered, candidates, strict=True)
            )

        for block, ranges, confidence in assignments:
            matches[block["element_id"]] = {
                "block": block,
                "ranges": ranges,
                "confidence": confidence,
            }

    body_blocks = tuple(
        block
        for block in sorted(blocks, key=lambda item: item["ordinal"])
        if block["element_type"]
        not in {"header_paragraph", "footer_paragraph"}
    )
    for _pass in range(len(body_blocks)):
        token_owners: set[int] = {
            token_index
            for match in matches.values()
            for start, end in match["ranges"]
            for token_index in range(start, end)
        }
        contextual_assignments: list[
            tuple[dict, tuple[int, int]]
        ] = []
        for block in body_blocks:
            element_id = block["element_id"]
            if element_id in matches:
                continue
            candidates = candidates_by_element_id[element_id]
            if not candidates:
                continue

            previous = max(
                (
                    match
                    for match in matches.values()
                    if match["block"]["element_type"]
                    not in {"header_paragraph", "footer_paragraph"}
                    and match["block"]["ordinal"] < block["ordinal"]
                ),
                key=lambda match: match["block"]["ordinal"],
                default=None,
            )
            following = min(
                (
                    match
                    for match in matches.values()
                    if match["block"]["element_type"]
                    not in {"header_paragraph", "footer_paragraph"}
                    and match["block"]["ordinal"] > block["ordinal"]
                ),
                key=lambda match: match["block"]["ordinal"],
                default=None,
            )
            if previous is None and following is None:
                continue
            lower_bound = (
                max(end for _start, end in previous["ranges"])
                if previous is not None
                else None
            )
            upper_bound = (
                min(start for start, _end in following["ranges"])
                if following is not None
                else None
            )
            bounded = [
                (start, end)
                for start, end in candidates
                if (lower_bound is None or start >= lower_bound)
                and (upper_bound is None or end <= upper_bound)
                and all(
                    token_index not in token_owners
                    for token_index in range(start, end)
                )
            ]
            if len(bounded) == 1:
                contextual_assignments.append((block, bounded[0]))

        if not contextual_assignments:
            break
        for block, candidate in contextual_assignments:
            matches[block["element_id"]] = {
                "block": block,
                "ranges": [candidate],
                "confidence": 0.93,
            }

    token_owners: dict[int, set[str]] = {}
    for element_id, match in matches.items():
        for start, end in match["ranges"]:
            for token_index in range(start, end):
                token_owners.setdefault(token_index, set()).add(element_id)
    preferred_owner: dict[int, str] = {}
    for token_index, owners in token_owners.items():
        preferred_owner[token_index] = max(
            owners,
            key=lambda element_id: (
                matches[element_id]["block"]["element_type"]
                not in {"header_paragraph", "footer_paragraph"},
                float(matches[element_id]["confidence"]),
                len(_normalise_tokens(matches[element_id]["block"]["text"])),
                bool(matches[element_id]["block"]["supported"]),
                -int(matches[element_id]["block"]["ordinal"]),
            ),
        )
    overlap_removed: set[str] = set()
    for element_id, match in list(matches.items()):
        safe_ranges = [
            (start, end)
            for start, end in match["ranges"]
            if all(
                preferred_owner[index] == element_id
                for index in range(start, end)
            )
        ]
        if safe_ranges:
            match["ranges"] = safe_ranges
            continue
        del matches[element_id]
        overlap_removed.add(element_id)

    unmapped: list[dict] = []
    for block in blocks:
        element_id = block["element_id"]
        if element_id in matches:
            continue
        candidates = candidates_by_element_id[element_id]
        unmapped.append(
            {
                "element_id": element_id,
                "element_type": block["element_type"],
                "reason": (
                    "The PDF range overlaps another block and is not safe to select."
                    if element_id in overlap_removed
                    else "No reliable PDF text region was found."
                    if not candidates
                    else "Repeated PDF text could not be resolved safely from context and order."
                ),
            }
        )
    return matches, unmapped


def _match_tokens(match: dict, tokens: list[dict]) -> list[dict]:
    return [
        tokens[token_index]
        for start, end in match["ranges"]
        for token_index in range(start, end)
    ]


def _point_inside_box(x: float, y: float, box: tuple[float, ...]) -> bool:
    x0, y0, x1, y1 = box
    return x0 <= x <= x1 and y0 <= y <= y1


def _match_empty_table_blocks(
    blocks: tuple[dict, ...],
    matches: dict[str, dict],
    tokens: list[dict],
    geometry: dict,
) -> None:
    empty_blocks = sorted(
        (
            block
            for block in blocks
            if block["element_type"] == "table_paragraph"
            and not _normalise_tokens(block["text"])
            and block["element_id"] not in matches
        ),
        key=lambda block: (
            int(block["location"].get("table_index", -1)),
            int(block["location"].get("row_index", -1)),
            -int(block["location"].get("column_index", -1)),
            int(block["location"].get("paragraph_index", -1)),
        ),
    )
    if not empty_blocks:
        return

    anchors_by_table: dict[int, list[dict]] = {}
    for match in matches.values():
        block = match["block"]
        location = block["location"]
        if block["element_type"] != "table_paragraph":
            continue
        if "table_index" not in location:
            continue
        anchors_by_table.setdefault(int(location["table_index"]), []).append(
            match
        )

    pdf_tables = list(geometry.get("tables") or [])
    table_scores: dict[tuple[int, int], int] = {}
    for table_index, anchors in anchors_by_table.items():
        for pdf_index, pdf_table in enumerate(pdf_tables):
            score = 0
            cells = pdf_table["cells"]
            for anchor in anchors:
                location = anchor["block"]["location"]
                cell_key = (
                    int(location.get("row_index", -1)),
                    int(location.get("column_index", -1)),
                )
                cell_box = cells.get(cell_key)
                if cell_box is None:
                    continue
                if any(
                    token["page_number"] == pdf_table["page_number"]
                    and _point_inside_box(
                        (float(token["x0"]) + float(token["x1"])) / 2,
                        (float(token["y0"]) + float(token["y1"])) / 2,
                        cell_box,
                    )
                    for token in _match_tokens(anchor, tokens)
                ):
                    score += 1
            if score:
                table_scores[(table_index, pdf_index)] = score

    horizontal_lines = list(geometry.get("horizontal_lines") or [])
    claimed_geometry: set[tuple[float, ...]] = set()
    for block in empty_blocks:
        location = block["location"]
        table_index = int(location.get("table_index", -1))
        row_index = int(location.get("row_index", -1))
        column_index = int(location.get("column_index", -1))
        cell_candidates: list[tuple[int, int, dict, tuple[float, ...]]] = []
        for pdf_index, pdf_table in enumerate(pdf_tables):
            score = table_scores.get((table_index, pdf_index), 0)
            cell_box = pdf_table["cells"].get((row_index, column_index))
            if score and cell_box is not None:
                cell_candidates.append((score, -pdf_index, pdf_table, cell_box))
        if cell_candidates:
            _score, _order, pdf_table, cell_box = max(
                cell_candidates,
                key=lambda item: (item[0], item[1]),
            )
            x0, y0, x1, y1 = cell_box
            geometry_key = (
                float(pdf_table["page_number"]),
                float(x0),
                float(y0),
                float(x1),
                float(y1),
            )
            if geometry_key in claimed_geometry:
                continue
            claimed_geometry.add(geometry_key)
            inset = min(2.0, max(0.0, (x1 - x0) / 10), max(0.0, (y1 - y0) / 10))
            matches[block["element_id"]] = {
                "block": block,
                "ranges": [],
                "confidence": 0.98,
                "geometric_boxes": [
                    {
                        "page_number": pdf_table["page_number"],
                        "page_width": pdf_table["page_width"],
                        "page_height": pdf_table["page_height"],
                        "x0": x0 + inset,
                        "y0": y0 + inset,
                        "x1": x1 - inset,
                        "y1": y1 - inset,
                        "mapping_method": "word_pdf_empty_table_cell",
                    }
                ],
            }
            continue

        same_row_anchors = [
            anchor
            for anchor in anchors_by_table.get(table_index, [])
            if int(anchor["block"]["location"].get("row_index", -1))
            == row_index
            and int(anchor["block"]["location"].get("column_index", -1))
            < column_index
        ]
        line_candidates: list[tuple[float, float, dict, dict]] = []
        for anchor in same_row_anchors:
            anchor_tokens = _match_tokens(anchor, tokens)
            for page_number in {
                int(token["page_number"]) for token in anchor_tokens
            }:
                page_tokens = [
                    token
                    for token in anchor_tokens
                    if int(token["page_number"]) == page_number
                ]
                anchor_x1 = max(float(token["x1"]) for token in page_tokens)
                anchor_y1 = max(float(token["y1"]) for token in page_tokens)
                for line in horizontal_lines:
                    if int(line["page_number"]) != page_number:
                        continue
                    vertical_gap = float(line["y0"]) - anchor_y1
                    if not 0 <= vertical_gap <= 24:
                        continue
                    if float(line["x0"]) < anchor_x1 + 8:
                        continue
                    geometry_key = (
                        float(line["page_number"]),
                        float(line["x0"]),
                        float(line["y0"]),
                        float(line["x1"]),
                        float(line["y1"]),
                    )
                    if geometry_key in claimed_geometry:
                        continue
                    line_candidates.append(
                        (
                            vertical_gap,
                            -(float(line["x1"]) - float(line["x0"])),
                            line,
                            page_tokens[0],
                        )
                    )
        if not line_candidates:
            continue
        _gap, _width, line, page_token = min(
            line_candidates,
            key=lambda item: (item[0], item[1]),
        )
        claimed_geometry.add(
            (
                float(line["page_number"]),
                float(line["x0"]),
                float(line["y0"]),
                float(line["x1"]),
                float(line["y1"]),
            )
        )
        matches[block["element_id"]] = {
            "block": block,
            "ranges": [],
            "confidence": 0.96,
            "geometric_boxes": [
                {
                    "page_number": line["page_number"],
                    "page_width": page_token["page_width"],
                    "page_height": page_token["page_height"],
                    "x0": line["x0"],
                    "y0": max(0.0, float(line["y0"]) - 16.0),
                    "x1": line["x1"],
                    "y1": float(line["y1"]) + 4.0,
                    "mapping_method": "word_pdf_empty_signature_line",
                }
            ],
        }


def _regions_for_match(
    match: dict,
    tokens: list[dict],
    context: _RenderContext,
) -> list[dict]:
    block = match["block"]
    confidence = float(match["confidence"])
    interactive = bool(
        block["supported"]
        and confidence >= settings.render_map_confidence_threshold
    )
    geometric_boxes = list(match.get("geometric_boxes") or [])
    if geometric_boxes:
        regions: list[dict] = []
        for region_index, box in enumerate(geometric_boxes, start=1):
            page_number = int(box["page_number"])
            page_width = float(box["page_width"])
            page_height = float(box["page_height"])
            x0 = max(0.0, min(float(box["x0"]), page_width))
            y0 = max(0.0, min(float(box["y0"]), page_height))
            x1 = max(x0, min(float(box["x1"]), page_width))
            y1 = max(y0, min(float(box["y1"]), page_height))
            coordinates = (
                x0 / page_width,
                y0 / page_height,
                (x1 - x0) / page_width,
                (y1 - y0) / page_height,
            )
            if (
                x1 <= x0
                or y1 <= y0
                or not all(
                    math.isfinite(value) and 0 <= value <= 1
                    for value in coordinates
                )
            ):
                continue
            reason = None
            if not block["supported"]:
                reason = (
                    block["unsupported_reason"]
                    or "This Word structure is read-only."
                )
            elif not interactive:
                reason = (
                    "The coordinate match is below the interactive confidence threshold."
                )
            regions.append(
                {
                    "region_id": (
                        f"{block['element_id']}:{page_number}:{region_index}"
                    ),
                    "region_index": region_index,
                    "render_id": None,
                    "element_id": block["element_id"],
                    "document_id": context.document_id,
                    "version_id": context.version_id,
                    "element_type": block["element_type"],
                    "text_preview": block["text"][:160],
                    "location": block["location"],
                    "page_number": page_number,
                    "x": round(coordinates[0], 7),
                    "y": round(coordinates[1], 7),
                    "width": round(coordinates[2], 7),
                    "height": round(coordinates[3], 7),
                    "confidence": confidence,
                    "mapping_method": str(box["mapping_method"]),
                    "interactive": interactive,
                    "editable": interactive,
                    "supported": bool(block["supported"]),
                    "read_only": not interactive,
                    "reason": reason,
                    "read_only_reason": reason,
                }
            )
        return regions

    lines: dict[tuple[int, int, int], list[dict]] = {}
    for start, end in match["ranges"]:
        seen: set[tuple[int, int, int, int]] = set()
        for token in tokens[start:end]:
            word_key = (
                token["page_number"],
                token["block_number"],
                token["line_number"],
                token["word_number"],
            )
            if word_key in seen:
                continue
            seen.add(word_key)
            lines.setdefault(word_key[:3], []).append(token)

    regions: list[dict] = []
    for region_index, (line_key, words) in enumerate(sorted(lines.items()), start=1):
        page_number = line_key[0]
        page_width = words[0]["page_width"]
        page_height = words[0]["page_height"]
        x0 = max(0.0, min(word["x0"] for word in words))
        y0 = max(0.0, min(word["y0"] for word in words))
        x1 = min(page_width, max(word["x1"] for word in words))
        y1 = min(page_height, max(word["y1"] for word in words))
        coordinates = (
            x0 / page_width,
            y0 / page_height,
            (x1 - x0) / page_width,
            (y1 - y0) / page_height,
        )
        if not all(math.isfinite(value) and 0 <= value <= 1 for value in coordinates):
            continue
        reason = None
        if not block["supported"]:
            reason = block["unsupported_reason"] or "This Word structure is read-only."
        elif not interactive:
            reason = "The coordinate match is below the interactive confidence threshold."
        regions.append(
            {
                "region_id": f"{block['element_id']}:{page_number}:{region_index}",
                "region_index": region_index,
                "render_id": None,
                "element_id": block["element_id"],
                "document_id": context.document_id,
                "version_id": context.version_id,
                "element_type": block["element_type"],
                "text_preview": block["text"][:160],
                "location": block["location"],
                "page_number": page_number,
                "x": round(coordinates[0], 7),
                "y": round(coordinates[1], 7),
                "width": round(coordinates[2], 7),
                "height": round(coordinates[3], 7),
                "confidence": confidence,
                "mapping_method": "word_pdf_text_context_order",
                "interactive": interactive,
                "editable": interactive,
                "supported": bool(block["supported"]),
                "read_only": not interactive,
                "reason": reason,
                "read_only_reason": reason,
            }
        )
    return regions


def _extract_pdf_structure(
    context: _RenderContext,
    render_id: str,
) -> tuple[list[dict], list[dict], dict]:
    pages: list[dict] = []
    tokens: list[dict] = []
    geometry: dict[str, list[dict]] = {
        "tables": [],
        "horizontal_lines": [],
    }
    needs_empty_table_geometry = any(
        block["element_type"] == "table_paragraph"
        and not _normalise_tokens(block["text"])
        for block in context.blocks
    )
    with context.pdf_path.open("rb") as source:
        header = source.read(8)
        source.seek(max(0, context.pdf_size - 2048))
        trailer = source.read()
    if not header.startswith(b"%PDF-") or b"%%EOF" not in trailer:
        raise ValueError("The Word render is not a complete PDF.")

    with pymupdf.open(context.pdf_path) as pdf:
        if not pdf.is_pdf or pdf.needs_pass:
            raise ValueError("The Word render is not an accessible PDF.")
        if pdf.page_count > settings.render_map_max_pages:
            raise ValueError(
                f"The PDF has {pdf.page_count} pages; the safe limit is {settings.render_map_max_pages}."
            )
        for page_index, page in enumerate(pdf):
            page_number = page_index + 1
            width = float(page.rect.width)
            height = float(page.rect.height)
            if width <= 0 or height <= 0:
                raise ValueError(f"PDF page {page_number} has invalid dimensions.")
            pages.append(
                {
                    "page_id": f"{render_id}:{page_number}",
                    "page_number": page_number,
                    "page_width": width,
                    "page_height": height,
                    "width": width,
                    "height": height,
                    "coordinate_unit": "normalised",
                    "render_version": render_id,
                    "aspect_ratio": width / height,
                    "image_width": round(width * settings.render_map_dpi / 72),
                    "image_height": round(height * settings.render_map_dpi / 72),
                    "image_url": (
                        f"/api/document-versions/{context.version_id}/render-pages/"
                        f"{render_id}/{page_number}.png"
                    ),
                }
            )
            words = page.get_text("words", sort=True)
            line_token_counts: dict[tuple[int, int], int] = {}
            for word in words:
                if len(word) < 8:
                    continue
                line_key = (int(word[5]), int(word[6]))
                line_token_counts[line_key] = line_token_counts.get(
                    line_key, 0
                ) + len(_normalise_tokens(str(word[4])))
            for word in words:
                if len(word) < 8:
                    continue
                x0, y0, x1, y1, raw_text, block_number, line_number, word_number = word[:8]
                if not all(math.isfinite(float(value)) for value in (x0, y0, x1, y1)):
                    continue
                values = _normalise_tokens(str(raw_text))
                is_automatic_page_number = bool(
                    values == (str(page_number),)
                    and line_token_counts.get(
                        (int(block_number), int(line_number))
                    )
                    == 1
                    and (
                        (float(y0) + float(y1)) / 2 / height < 0.055
                        or (float(y0) + float(y1)) / 2 / height > 0.945
                    )
                )
                if is_automatic_page_number:
                    continue
                for value in values:
                    tokens.append(
                        {
                            "value": value,
                            "page_number": page_number,
                            "page_width": width,
                            "page_height": height,
                            "x0": float(x0),
                            "y0": float(y0),
                            "x1": float(x1),
                            "y1": float(y1),
                            "block_number": int(block_number),
                            "line_number": int(line_number),
                            "word_number": int(word_number),
                        }
                    )
            if needs_empty_table_geometry:
                try:
                    found_tables = page.find_tables().tables
                except Exception:
                    logger.warning(
                        "docsync.render_map.table_geometry_failed "
                        "version_id=%s page=%s",
                        context.version_id,
                        page_number,
                        exc_info=True,
                    )
                    found_tables = []
                for found_table in found_tables:
                    cells: dict[tuple[int, int], tuple[float, ...]] = {}
                    for row_index, row in enumerate(found_table.rows):
                        for column_index, cell_box in enumerate(row.cells):
                            if cell_box is None:
                                continue
                            cells[(row_index, column_index)] = tuple(
                                float(value) for value in cell_box
                            )
                    if not cells:
                        continue
                    geometry["tables"].append(
                        {
                            "page_number": page_number,
                            "page_width": width,
                            "page_height": height,
                            "row_count": int(found_table.row_count),
                            "column_count": int(found_table.col_count),
                            "cells": cells,
                        }
                    )
                try:
                    drawings = page.get_drawings()
                except Exception:
                    logger.warning(
                        "docsync.render_map.line_geometry_failed "
                        "version_id=%s page=%s",
                        context.version_id,
                        page_number,
                        exc_info=True,
                    )
                    drawings = []
                for drawing in drawings:
                    rect = drawing.get("rect")
                    if rect is None or rect.width < 60 or rect.height > 3:
                        continue
                    geometry["horizontal_lines"].append(
                        {
                            "page_number": page_number,
                            "x0": float(rect.x0),
                            "y0": float(rect.y0),
                            "x1": float(rect.x1),
                            "y1": float(rect.y1),
                        }
                    )
    return pages, tokens, geometry


def _render_pdf_page(
    context: _RenderContext,
    render_id: str,
    page_number: int,
) -> Path:
    page_directory = (
        context.cache_path.parent / f"{context.version_id}.pages" / render_id
    ).resolve()
    image_path = (page_directory / f"page-{page_number}.png").resolve()
    try:
        image_path.relative_to(page_directory)
    except ValueError as exc:
        raise ValueError("The preview page path is invalid.") from exc
    lock = PAGE_RENDER_LOCKS[hash(str(image_path)) % len(PAGE_RENDER_LOCKS)]
    with lock:
        if image_path.is_file() and image_path.stat().st_size > 0:
            return image_path
        pdf_stat = context.pdf_path.stat()
        if (
            pdf_stat.st_size != context.pdf_size
            or pdf_stat.st_mtime_ns != context.pdf_mtime_ns
        ):
            raise ValueError("The immutable PDF identity changed during page rendering.")
        started_at = perf_counter()
        with pymupdf.open(context.pdf_path) as pdf:
            if page_number < 1 or page_number > pdf.page_count:
                raise ValueError("The preview page number is invalid.")
            page = pdf.load_page(page_number - 1)
            matrix = pymupdf.Matrix(
                settings.render_map_dpi / 72,
                settings.render_map_dpi / 72,
            )
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            image_bytes = pixmap.tobytes("png")
        page_directory.mkdir(parents=True, exist_ok=True)
        temporary_image = image_path.with_name(
            f"{image_path.name}.{uuid4().hex}.tmp"
        )
        try:
            temporary_image.write_bytes(image_bytes)
            temporary_image.replace(image_path)
        finally:
            temporary_image.unlink(missing_ok=True)
        logger.info(
            "docsync.render_page_timing version_id=%s render_id=%s page=%s "
            "cache_hit=false duration_ms=%.2f",
            context.version_id,
            render_id,
            page_number,
            (perf_counter() - started_at) * 1000,
        )
        return image_path


def _prefetch_initial_pages(
    context: _RenderContext,
    render_id: str,
    page_count: int,
) -> None:
    for page_number in range(1, min(page_count, 2) + 1):
        try:
            _render_pdf_page(context, render_id, page_number)
        except Exception:
            logger.exception(
                "docsync.render_page.prefetch_failed version_id=%s page=%s",
                context.version_id,
                page_number,
            )


def _generate_render_map(context: _RenderContext, key: str) -> None:
    total_started = perf_counter()
    processing = _status_payload(
        context,
        "processing",
        "Rendering controlled preview pages.",
    )
    _write_cache(context.cache_path, processing)
    try:
        stage_started = perf_counter()
        pdf_sha256 = _sha256_file(context.pdf_path)
        pdf_read_ms = (perf_counter() - stage_started) * 1000
        identity = json.dumps(
            {
                "version_id": context.version_id,
                "source_sha256": context.source_sha256,
                "pdf_sha256": pdf_sha256,
                "map_engine": RENDER_MAP_ENGINE,
                "mapper_version": pymupdf.__version__,
                "dpi": settings.render_map_dpi,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        render_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
        stage_started = perf_counter()
        pages, tokens, geometry = _extract_pdf_structure(context, render_id)
        text_extraction_ms = (perf_counter() - stage_started) * 1000
        logger.info(
            "docsync.render_map_text_extraction_timing version_id=%s pages=%s "
            "duration_ms=%.2f",
            context.version_id,
            len(pages),
            text_extraction_ms,
        )

        # Publish controlled page images before contextual coordinate matching.
        progressive = {
            **processing,
            "status_detail": "The PDF is visible. Preparing selectable text in the background.",
            "pdf_sha256": pdf_sha256,
            "render_id": render_id,
            "render_version": render_id,
            "page_count": len(pages),
            "pages": pages,
        }
        _write_cache(context.cache_path, progressive)

        stage_started = perf_counter()
        matches, unmapped = _match_blocks(context.blocks, tokens)
        _match_empty_table_blocks(
            context.blocks,
            matches,
            tokens,
            geometry,
        )
        mapped_match_ids = set(matches)
        unmapped = [
            item
            for item in unmapped
            if item["element_id"] not in mapped_match_ids
        ]
        block_matching_ms = (perf_counter() - stage_started) * 1000
        regions = [
            region
            for match in matches.values()
            for region in _regions_for_match(match, tokens, context)
        ]
        for region in regions:
            region["render_id"] = render_id
        mapped_ids = {region["element_id"] for region in regions}
        interactive_ids = {
            region["element_id"] for region in regions if region["interactive"]
        }
        total = len(context.blocks)
        if total and not mapped_ids:
            status = "failed"
            detail = (
                "The PDF remains available, but no blocks could be mapped reliably. "
                "Retry the Word preview after closing any open Word dialogue."
            )
        elif len(mapped_ids) < total:
            status = "partial"
            detail = (
                "Reliable Word areas are editable. A small number of unsupported "
                "or non-rendered structures remain read-only."
            )
        else:
            status = "completed"
            detail = "Selectable areas are aligned to this immutable Word/PDF render."
        payload = {
            **progressive,
            "status": status,
            "status_detail": detail,
            "regions": regions,
            "mapped_element_count": len(mapped_ids),
            "interactive_element_count": len(interactive_ids),
            "unmapped": unmapped,
            "generated_at": _utc_now(),
        }
        _write_cache(context.cache_path, payload)
        RENDER_MAP_EXECUTOR.submit(
            _prefetch_initial_pages,
            context,
            render_id,
            len(pages),
        )
        logger.info(
            "docsync.render_map_timing version_id=%s pages=%s blocks=%s "
            "pdf_read_ms=%.2f text_extraction_ms=%.2f "
            "block_matching_ms=%.2f total_ms=%.2f",
            context.version_id,
            len(pages),
            len(context.blocks),
            pdf_read_ms,
            text_extraction_ms,
            block_matching_ms,
            (perf_counter() - total_started) * 1000,
        )
    except Exception as exc:
        logger.exception("docsync.render_map.failed version_id=%s", context.version_id)
        failed = {
            **processing,
            "status": "failed",
            "status_detail": (
                "The PDF remains available, but selectable text could not be prepared. "
                "Retry after closing any Microsoft Word dialog."
            ),
            "error": str(exc),
            "generated_at": _utc_now(),
        }
        _write_cache(context.cache_path, failed)
    finally:
        with RENDER_MAP_LOCK:
            ACTIVE_RENDER_MAPS.discard(key)
            RENDER_MAP_EVENTS.setdefault(key, threading.Event()).set()


def render_page_path(
    session: Session,
    version_id: str,
    render_id: str,
    page_number: int,
) -> Path:
    if not RENDER_ID_PATTERN.fullmatch(render_id) or page_number < 1:
        raise HTTPException(status_code=404, detail="The preview page is unavailable.")
    payload = request_render_map(session, version_id)
    if payload.get("render_id") != render_id:
        raise HTTPException(status_code=404, detail="The preview page is unavailable.")
    page = next(
        (
            item
            for item in payload.get("pages", [])
            if int(item.get("page_number", 0)) == page_number
        ),
        None,
    )
    if page is None:
        raise HTTPException(status_code=404, detail="The preview page is unavailable.")
    version = session.get(DocumentVersion, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Document version not found.")
    context = _context_for_version(version)
    if context is None or not _cache_matches(_read_cache(context.cache_path), context):
        raise HTTPException(status_code=404, detail="The preview page is unavailable.")
    try:
        path = _render_pdf_page(context, render_id, page_number)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=404,
            detail="The preview page is unavailable.",
        ) from exc
    return path
