"""Measure PDF text extraction separately from lazy page rasterisation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
from time import perf_counter

import pymupdf


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--pages", type=int, default=40)
    args = parser.parse_args()
    if args.pages < 3:
        parser.error("Use at least three pages.")
    args.data_dir.mkdir(parents=True, exist_ok=False)
    os.environ["DOCUMENTSYNC_DATA_DIR"] = str(args.data_dir)
    os.environ["DOCUMENTSYNC_WORD_WORKER_AUTOSTART"] = "0"
    api_directory = Path(__file__).resolve().parents[1]
    if str(api_directory) not in sys.path:
        sys.path.insert(0, str(api_directory))
    from app.render_map_service import (
        _RenderContext,
        _extract_pdf_structure,
        _match_blocks,
        _render_pdf_page,
    )

    source_path = args.data_dir / "benchmark.docx"
    source_path.write_bytes(b"synthetic benchmark identity")
    pdf_path = args.data_dir / "benchmark.pdf"
    pdf = pymupdf.open()
    blocks = []
    for page_number in range(1, args.pages + 1):
        page = pdf.new_page(width=612, height=792)
        value = f"Unique benchmark clause for page {page_number:04d}"
        page.insert_text((72, 100), value, fontsize=11)
        blocks.append(
            {
                "element_id": f"element-{page_number}",
                "ordinal": page_number - 1,
                "element_type": "paragraph",
                "text": value,
                "location": {"kind": "body", "paragraph_index": page_number - 1},
                "supported": True,
                "unsupported_reason": None,
            }
        )
    pdf.save(pdf_path)
    pdf.close()
    pdf_stat = pdf_path.stat()
    cache_path = args.data_dir / "benchmark.render-map.json"
    context = _RenderContext(
        version_id="benchmark-version",
        document_id="benchmark-document",
        document_set_id="benchmark-set",
        source_path=source_path,
        source_sha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
        pdf_path=pdf_path,
        pdf_size=pdf_stat.st_size,
        pdf_mtime_ns=pdf_stat.st_mtime_ns,
        cache_path=cache_path,
        blocks=tuple(blocks),
    )

    extraction_started = perf_counter()
    pages, tokens = _extract_pdf_structure(context, "1" * 24)
    extraction_ms = (perf_counter() - extraction_started) * 1000
    assert not list(args.data_dir.glob("benchmark-version.pages/**/*.png"))

    matching_started = perf_counter()
    matches, _unmapped = _match_blocks(context.blocks, tokens)
    matching_ms = (perf_counter() - matching_started) * 1000

    first_started = perf_counter()
    _render_pdf_page(context, "2" * 24, 1)
    first_page_ms = (perf_counter() - first_started) * 1000

    full_directory = args.data_dir / "benchmark-version.pages" / ("3" * 24)
    full_runs = []
    for page_number in range(1, len(pages) + 1):
        started_at = perf_counter()
        _render_pdf_page(context, "3" * 24, page_number)
        full_runs.append((perf_counter() - started_at) * 1000)

    print(
        json.dumps(
            {
                "pages": len(pages),
                "tokens": len(tokens),
                "matched_blocks": len(matches),
                "text_extraction_ms": round(extraction_ms, 2),
                "block_matching_ms": round(matching_ms, 2),
                "first_page_rasterisation_ms": round(first_page_ms, 2),
                "full_document_rasterisation_ms": round(sum(full_runs), 2),
                "page_rasterisation_median_ms": round(statistics.median(full_runs), 2),
                "initial_png_count": 0,
                "explicit_full_png_count": len(list(full_directory.glob("*.png"))),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
