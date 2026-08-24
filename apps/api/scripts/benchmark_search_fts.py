"""Compare current-version FTS5 search with the previous substring candidate scan."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import statistics
import sys
from time import perf_counter
from uuid import uuid4

from sqlalchemy import func, insert, select, text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--documents", type=int, default=50)
    parser.add_argument("--blocks", type=int, default=1_000)
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    if args.documents < 2 or args.blocks < 10 or args.runs < 1:
        parser.error("Use at least two documents, ten blocks, and one run.")
    args.data_dir.mkdir(parents=True, exist_ok=False)
    os.environ["DOCUMENTSYNC_DATA_DIR"] = str(args.data_dir)
    os.environ["DOCUMENTSYNC_DATABASE_URL"] = f"sqlite:///{(args.data_dir / 'search.db').as_posix()}"
    os.environ["DOCUMENTSYNC_WORD_WORKER_AUTOSTART"] = "0"
    api_directory = Path(__file__).resolve().parents[1]
    if str(api_directory) not in sys.path:
        sys.path.insert(0, str(api_directory))

    from app.database import SessionLocal, init_db
    from app.document_service import search_document_set
    from app.models import (
        DocumentBlockRevision,
        DocumentHead,
        DocumentRecord,
        DocumentSet,
        DocumentVersion,
    )

    init_db()
    set_id = str(uuid4())
    created_at = datetime.now(timezone.utc)
    document_rows = []
    version_rows = []
    head_rows = []
    revision_rows = []
    needle = "distinctive searchable performance phrase"
    for document_number in range(args.documents):
        document_id = str(uuid4())
        document_rows.append(
            {
                "id": document_id,
                "document_set_id": set_id,
                "original_name": f"Search-{document_number + 1:03d}.docx",
                "stored_name": f"{set_id}/{document_id}.docx",
                "checksum_sha256": "0" * 64,
                "created_at": created_at,
            }
        )
        version_rows.append(
            {
                "id": document_id,
                "document_id": document_id,
                "parent_version_id": None,
                "generation_id": None,
                "editor_operation_id": None,
                "version_number": 1,
                "storage_area": "originals",
                "storage_name": f"{set_id}/{document_id}.docx",
                "download_name": f"Search-{document_number + 1:03d}.docx",
                "checksum_sha256": "0" * 64,
                "created_at": created_at,
            }
        )
        head_rows.append(
            {
                "document_id": document_id,
                "current_version_id": document_id,
                "revision": 1,
                "updated_at": created_at,
            }
        )
        for ordinal in range(args.blocks):
            value = (
                f"Block {ordinal}: {needle}."
                if ordinal % 100 == 0
                else f"Document {document_number} ordinary content block {ordinal}."
            )
            revision_rows.append(
                {
                    "id": str(uuid4()),
                    "version_id": document_id,
                    "element_id": str(uuid4()),
                    "document_id": document_id,
                    "ordinal": ordinal,
                    "element_type": "paragraph",
                    "text": value,
                    "normalized_text": value.casefold(),
                    "exact_match_hash": None,
                    "structure_hash": None,
                    "delta_json": {"ops": [{"insert": value + "\n"}]},
                    "formatting_json": {},
                    "list_type": None,
                    "list_level": None,
                    "alignment": None,
                    "location_json": {"kind": "body", "paragraph_index": ordinal},
                    "shared_state": "shared",
                    "supported": True,
                    "unsupported_reason": None,
                    "created_at": created_at,
                }
            )

    with SessionLocal() as session:
        session.execute(insert(DocumentSet.__table__), [{"id": set_id, "name": "Search benchmark", "created_at": created_at}])
        session.execute(insert(DocumentRecord.__table__), document_rows)
        session.execute(insert(DocumentVersion.__table__), version_rows)
        session.execute(insert(DocumentHead.__table__), head_rows)
        session.execute(insert(DocumentBlockRevision.__table__), revision_rows)
        session.commit()

        fts_runs = []
        fts_candidate_runs = []
        substring_runs = []
        result_count = 0
        for _ in range(args.runs):
            started_at = perf_counter()
            result_count = search_document_set(session, set_id, needle)["result_count"]
            fts_runs.append((perf_counter() - started_at) * 1000)

            started_at = perf_counter()
            session.execute(
                text(
                    "SELECT COUNT(*) FROM document_block_fts f "
                    "JOIN document_block_revisions r ON r.id = f.revision_id "
                    "JOIN document_heads h ON h.current_version_id = r.version_id "
                    "JOIN documents d ON d.id = r.document_id "
                    "WHERE d.document_set_id = :set_id "
                    "AND f.normalized_text MATCH :query"
                ),
                {"set_id": set_id, "query": f'"{needle}"'},
            ).scalar_one()
            fts_candidate_runs.append((perf_counter() - started_at) * 1000)

            started_at = perf_counter()
            session.execute(
                select(func.count(DocumentBlockRevision.id))
                .join(DocumentHead, DocumentHead.current_version_id == DocumentBlockRevision.version_id)
                .join(DocumentRecord, DocumentRecord.id == DocumentBlockRevision.document_id)
                .where(
                    DocumentRecord.document_set_id == set_id,
                    DocumentBlockRevision.normalized_text.contains(needle, autoescape=True),
                )
            ).scalar_one()
            substring_runs.append((perf_counter() - started_at) * 1000)

    print(
        json.dumps(
            {
                "documents": args.documents,
                "blocks_per_document": args.blocks,
                "total_blocks": len(revision_rows),
                "result_count": result_count,
                "runs": args.runs,
                "fts_end_to_end_median_ms": round(statistics.median(fts_runs), 2),
                "fts_candidate_median_ms": round(statistics.median(fts_candidate_runs), 2),
                "substring_candidate_median_ms": round(statistics.median(substring_runs), 2),
                "fts_runs_ms": [round(value, 2) for value in fts_runs],
                "fts_candidate_runs_ms": [round(value, 2) for value in fts_candidate_runs],
                "substring_runs_ms": [round(value, 2) for value in substring_runs],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
