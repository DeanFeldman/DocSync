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
import unicodedata
from uuid import uuid4

import pymupdf
from fastapi import HTTPException
from sqlalchemy.orm import Session

from .config import settings
from .models import DocumentBlockRevision, DocumentVersion


logger = logging.getLogger(__name__)

RENDER_MAP_SCHEMA_VERSION = 1
RENDER_MAP_ENGINE = "docsync-contextual-pdf-map-v1"
WORD_RENDER_ENGINE = "Microsoft Word ExportAsFixedFormat PDF"
TOKEN_PATTERN = re.compile(r"\w+", re.UNICODE)
RENDER_MAP_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="docsync-render-map",
)
RENDER_MAP_LOCK = threading.RLock()
ACTIVE_RENDER_MAPS: set[str] = set()


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
    return (
        settings.data_dir
        / "renders"
        / document_set_id
        / f"{version_id}.render-map.json"
    )


def _pdf_path(document_set_id: str, version_id: str) -> Path:
    return settings.data_dir / "renders" / document_set_id / f"{version_id}.pdf"


def _source_path(version: DocumentVersion) -> Path:
    allowed = {
        "originals": settings.data_dir / "originals",
        "generated": settings.data_dir / "generated",
    }
    root = allowed.get(version.storage_area)
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
    stat = pdf_path.stat()
    source_sha256 = version.checksum_sha256 or _sha256_file(source_path)
    return _RenderContext(
        version_id=version.id,
        document_id=version.document_id,
        document_set_id=document.document_set_id,
        source_path=source_path,
        source_sha256=source_sha256,
        pdf_path=pdf_path,
        pdf_size=stat.st_size,
        pdf_mtime_ns=stat.st_mtime_ns,
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
        "pdf_engine": WORD_RENDER_ENGINE,
        "coordinate_unit": "normalised",
        "source_sha256": context.source_sha256,
        "pdf_sha256": None,
        "pdf_size": context.pdf_size,
        "pdf_mtime_ns": context.pdf_mtime_ns,
        "interactive_threshold": settings.render_map_confidence_threshold,
        "render_id": None,
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
    # File-system fingerprints are internal cache validators. The cryptographic
    # source/PDF identities and immutable version identity remain public.
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
            "status_detail": "Generate the Word layout preview to create selectable areas.",
            "map_engine": RENDER_MAP_ENGINE,
            "mapper": "PyMuPDF",
            "mapper_version": pymupdf.__version__,
            "pdf_engine": WORD_RENDER_ENGINE,
            "coordinate_unit": "normalised",
            "source_sha256": version.checksum_sha256,
            "pdf_sha256": None,
            "interactive_threshold": settings.render_map_confidence_threshold,
            "render_id": None,
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
        return _public_payload(cached)

    key = f"{context.document_set_id}:{context.version_id}"
    with RENDER_MAP_LOCK:
        cached = _read_cache(context.cache_path)
        if key in ACTIVE_RENDER_MAPS and _cache_matches(cached, context):
            return _public_payload(cached)
        ACTIVE_RENDER_MAPS.add(key)
        queued = _status_payload(
            context,
            "queued",
            "The PDF is ready. Selectable areas are queued for background processing.",
        )
        _write_cache(context.cache_path, queued)
        RENDER_MAP_EXECUTOR.submit(_generate_render_map, context, key)
    return _public_payload(queued)


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


def _find_candidates(block: dict, tokens: list[dict], by_value: dict[str, list[int]]) -> list[tuple[int, int]]:
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
        # A selection may wrap across lines/pages, but may not start or end in
        # the middle of another line. This prevents substring-only matches.
        first = tokens[start]
        last = tokens[end - 1]
        if start > 0:
            previous = tokens[start - 1]
            if (
                previous["page_number"],
                previous["block_number"],
                previous["line_number"],
            ) == (
                first["page_number"],
                first["block_number"],
                first["line_number"],
            ):
                continue
        if end < len(tokens):
            following = tokens[end]
            if (
                following["page_number"],
                following["block_number"],
                following["line_number"],
            ) == (
                last["page_number"],
                last["block_number"],
                last["line_number"],
            ):
                continue
        if _candidate_context(block, tokens, start, end):
            candidates.append((start, end))
    return candidates


def _group_key(block: dict) -> tuple:
    location = block["location"]
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
        str(location.get("header_footer_type") or ""),
    )


def _match_blocks(blocks: tuple[dict, ...], tokens: list[dict]) -> tuple[dict[str, dict], list[dict]]:
    by_value: dict[str, list[int]] = {}
    for index, token in enumerate(tokens):
        by_value.setdefault(token["value"], []).append(index)

    grouped: dict[tuple, list[dict]] = {}
    for block in blocks:
        grouped.setdefault(_group_key(block), []).append(block)

    matches: dict[str, dict] = {}
    unmapped: list[dict] = []
    for group_blocks in sorted(grouped.values(), key=lambda items: items[0]["ordinal"]):
        ordered_blocks = sorted(group_blocks, key=lambda item: item["ordinal"])
        candidates = _find_candidates(ordered_blocks[0], tokens, by_value)
        element_type = ordered_blocks[0]["element_type"]
        is_header_footer = element_type in {"header_paragraph", "footer_paragraph"}
        assignments: list[tuple[dict, list[tuple[int, int]], float]] = []
        if is_header_footer and len(ordered_blocks) == 1 and candidates:
            # One deduplicated source part intentionally maps to every repeated
            # page occurrence of that same header/footer.
            assignments.append((ordered_blocks[0], candidates, 0.97))
        elif len(ordered_blocks) == 1 and len(candidates) == 1:
            assignments.append((ordered_blocks[0], [candidates[0]], 0.99))
        elif len(ordered_blocks) == len(candidates) and candidates:
            # Text + structural type/location + immutable document order form
            # a one-to-one resolution for genuine duplicate paragraphs.
            for block, candidate in zip(ordered_blocks, candidates, strict=True):
                assignments.append((block, [candidate], 0.95))

        assigned_ids = {item[0]["element_id"] for item in assignments}
        for block in ordered_blocks:
            if block["element_id"] not in assigned_ids:
                unmapped.append(
                    {
                        "element_id": block["element_id"],
                        "element_type": block["element_type"],
                        "reason": (
                            "No reliable PDF text region was found."
                            if not candidates
                            else "Repeated PDF text could not be resolved safely from context and order."
                        ),
                    }
                )
        for block, ranges, confidence in assignments:
            matches[block["element_id"]] = {
                "block": block,
                "ranges": ranges,
                "confidence": confidence,
            }

    # A PDF range must never activate two different Word blocks. This catches
    # cross-type duplicates and overlapping first/default header variants that
    # cannot be separated without section page-boundary information.
    token_owners: dict[int, set[str]] = {}
    for element_id, match in matches.items():
        for start, end in match["ranges"]:
            for token_index in range(start, end):
                token_owners.setdefault(token_index, set()).add(element_id)
    for element_id, match in list(matches.items()):
        safe_ranges = [
            (start, end)
            for start, end in match["ranges"]
            if all(len(token_owners[index]) == 1 for index in range(start, end))
        ]
        if safe_ranges:
            match["ranges"] = safe_ranges
            continue
        del matches[element_id]
        if not any(item["element_id"] == element_id for item in unmapped):
            unmapped.append(
                {
                    "element_id": element_id,
                    "element_type": match["block"]["element_type"],
                    "reason": "The PDF range overlaps another structured block and is not safe to select.",
                }
            )
    return matches, unmapped


def _regions_for_match(match: dict, tokens: list[dict], context: _RenderContext) -> list[dict]:
    block = match["block"]
    confidence = float(match["confidence"])
    interactive = bool(
        block["supported"]
        and confidence >= settings.render_map_confidence_threshold
    )
    lines: dict[tuple[int, int, int], list[dict]] = {}
    for start, end in match["ranges"]:
        seen_words: set[tuple] = set()
        for token in tokens[start:end]:
            word_key = (
                token["page_number"],
                token["block_number"],
                token["line_number"],
                token["word_number"],
            )
            if word_key in seen_words:
                continue
            seen_words.add(word_key)
            line_key = word_key[:3]
            lines.setdefault(line_key, []).append(token)

    regions: list[dict] = []
    for region_index, (line_key, words) in enumerate(sorted(lines.items()), start=1):
        page_number = line_key[0]
        page_width = words[0]["page_width"]
        page_height = words[0]["page_height"]
        x0 = max(0.0, min(word["x0"] for word in words))
        y0 = max(0.0, min(word["y0"] for word in words))
        x1 = min(page_width, max(word["x1"] for word in words))
        y1 = min(page_height, max(word["y1"] for word in words))
        coordinates = (x0 / page_width, y0 / page_height, (x1 - x0) / page_width, (y1 - y0) / page_height)
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


def _extract_pdf(context: _RenderContext, render_id: str) -> tuple[list[dict], list[dict]]:
    pages: list[dict] = []
    tokens: list[dict] = []
    page_directory = context.cache_path.parent / f"{context.version_id}.pages" / render_id
    page_directory.mkdir(parents=True, exist_ok=True)
    # Reject obviously incomplete/corrupt output before invoking the native PDF
    # parser. Besides producing a clearer failure, this avoids retaining a
    # Windows file handle when a malformed stream cannot be opened.
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
        scale = settings.render_map_dpi / 72
        matrix = pymupdf.Matrix(scale, scale)
        for page_index, page in enumerate(pdf):
            page_number = page_index + 1
            width = float(page.rect.width)
            height = float(page.rect.height)
            if width <= 0 or height <= 0:
                raise ValueError(f"PDF page {page_number} has invalid dimensions.")
            image_path = page_directory / f"page-{page_number}.png"
            temporary_image = image_path.with_name(f"{image_path.name}.{uuid4().hex}.tmp")
            try:
                pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                temporary_image.write_bytes(pixmap.tobytes("png"))
                temporary_image.replace(image_path)
            finally:
                temporary_image.unlink(missing_ok=True)
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
                    "image_width": pixmap.width,
                    "image_height": pixmap.height,
                    "image_url": (
                        f"/api/document-versions/{context.version_id}/render-pages/"
                        f"{render_id}/{page_number}.png"
                    ),
                }
            )
            for word in page.get_text("words", sort=True):
                if len(word) < 8:
                    continue
                x0, y0, x1, y1, raw_text, block_number, line_number, word_number = word[:8]
                if not all(math.isfinite(float(value)) for value in (x0, y0, x1, y1)):
                    continue
                for value in _normalise_tokens(str(raw_text)):
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
    return pages, tokens


def _generate_render_map(context: _RenderContext, key: str) -> None:
    processing = _status_payload(
        context,
        "processing",
        "Extracting PDF text geometry and matching immutable Word blocks.",
    )
    _write_cache(context.cache_path, processing)
    try:
        pdf_sha256 = _sha256_file(context.pdf_path)
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
        pages, tokens = _extract_pdf(context, render_id)
        matches, unmapped = _match_blocks(context.blocks, tokens)
        regions = [
            region
            for match in matches.values()
            for region in _regions_for_match(match, tokens, context)
        ]
        mapped_ids = {region["element_id"] for region in regions}
        interactive_ids = {
            region["element_id"] for region in regions if region["interactive"]
        }
        total = len(context.blocks)
        if total and not mapped_ids:
            status = "failed"
            detail = (
                "The PDF remains available, but no Word blocks could be mapped reliably. "
                "Use Select from structure."
            )
        elif len(mapped_ids) < total:
            status = "partial"
            detail = (
                "Selectable areas are available for reliable matches. Unresolved areas remain "
                "available through Select from structure."
            )
        else:
            status = "completed"
            detail = "Selectable areas are aligned to this immutable Word/PDF render."
        payload = {
            **processing,
            "status": status,
            "status_detail": detail,
            "pdf_sha256": pdf_sha256,
            "render_id": render_id,
            "render_version": render_id,
            "page_count": len(pages),
            "pages": pages,
            "regions": regions,
            "mapped_element_count": len(mapped_ids),
            "interactive_element_count": len(interactive_ids),
            "unmapped": unmapped,
            "generated_at": _utc_now(),
        }
        _write_cache(context.cache_path, payload)
    except Exception as exc:  # Keep the successful Word PDF available.
        logger.exception("docsync.render_map.failed version_id=%s", context.version_id)
        failed = {
            **processing,
            "status": "failed",
            "status_detail": (
                "The PDF remains available, but selectable areas could not be generated. "
                "Use Select from structure."
            ),
            "error": str(exc)[:500],
            "generated_at": _utc_now(),
        }
        _write_cache(context.cache_path, failed)
    finally:
        with RENDER_MAP_LOCK:
            ACTIVE_RENDER_MAPS.discard(key)


def render_page_path(
    session: Session,
    version_id: str,
    render_id: str,
    page_number: int,
) -> Path:
    from .editor_service import get_version_or_404

    version = get_version_or_404(session, version_id)
    context = _context_for_version(version)
    if context is None:
        raise HTTPException(status_code=404, detail="The Word PDF preview is not available.")
    payload = _read_cache(context.cache_path)
    if (
        not _cache_matches(payload, context)
        or payload.get("status") not in {"completed", "partial"}
        or payload.get("render_id") != render_id
        or not re.fullmatch(r"[0-9a-f]{24}", render_id)
        or page_number < 1
        or page_number > int(payload.get("page_count") or 0)
    ):
        raise HTTPException(status_code=404, detail="The render-map page is not available.")
    path = context.cache_path.parent / f"{version.id}.pages" / render_id / f"page-{page_number}.png"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="The render-map page is missing.")
    return path
