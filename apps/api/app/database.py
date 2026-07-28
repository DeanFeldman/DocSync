from __future__ import annotations

from collections.abc import Generator
import hashlib
import json
import logging
import re
import unicodedata
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

_ORDERED_TABLE_STYLE = re.compile(
    r"^table_cell_order:(\d+):(\d+):(\d+):(\d+)$"
)
_TABLE_STYLE = re.compile(r"^table_cell:(\d+):(\d+):(\d+)$")
_ORDERED_BODY_STYLE = re.compile(r"^body_order:(\d+):(.*)$", re.DOTALL)
_LIST_LEVEL_SUFFIX = re.compile(r"\s+(\d+)$")
_HEADING_LEVEL = re.compile(r"^heading\s+(\d+)$", re.IGNORECASE)


def init_db() -> None:
    from . import models  # noqa: F401
    from .migration_service import WorkspaceMigration, run_workspace_migrations

    def report_stage(stage: str) -> None:
        logger.warning("docsync.startup.stage=%s", stage)

    report_stage("checking_workspace_schema")
    result = run_workspace_migrations(
        engine=engine,
        database_url=settings.database_url,
        backup_directory=settings.data_dir / "migration-backups",
        create_schema=lambda connection: Base.metadata.create_all(bind=connection),
        migrations=(
            WorkspaceMigration(
                version=1,
                name="version_foundation",
                apply=_migrate_version_foundation,
            ),
        ),
        report_stage=report_stage,
    )
    if result.applied_versions:
        logger.warning(
            "docsync.startup.migrations_applied=%s backup=%s",
            ",".join(str(version) for version in result.applied_versions),
            result.backup_path or "not-required",
        )
    report_stage("workspace_schema_ready")


def _normalise_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _stored_file_checksum(storage_area: str, storage_name: str) -> str | None:
    return _sha256_file(settings.data_dir / storage_area / storage_name)


def _exact_match_hash(element_type: str, normalized_text: str) -> str:
    return hashlib.sha256(
        f"{element_type}\0{normalized_text}".encode("utf-8")
    ).hexdigest()


def _block_shape(style_name: str | None, paragraph_index: int) -> dict:
    raw_style = style_name or ""
    display_style = raw_style
    ordinal = paragraph_index
    location: dict[str, int] = {"paragraph_index": paragraph_index}

    table_match = _ORDERED_TABLE_STYLE.fullmatch(raw_style)
    if table_match is not None:
        order, table_index, row_index, column_index = (
            int(value) for value in table_match.groups()
        )
        ordinal = order
        location.update(
            {
                "table_index": table_index,
                "row_index": row_index,
                "column_index": column_index,
            }
        )
        element_type = "table_cell"
        display_style = None
    else:
        legacy_table_match = _TABLE_STYLE.fullmatch(raw_style)
        if legacy_table_match is not None:
            table_index, row_index, column_index = (
                int(value) for value in legacy_table_match.groups()
            )
            location.update(
                {
                    "table_index": table_index,
                    "row_index": row_index,
                    "column_index": column_index,
                }
            )
            element_type = "table_cell"
            display_style = None
        else:
            body_match = _ORDERED_BODY_STYLE.fullmatch(raw_style)
            if body_match is not None:
                ordinal = int(body_match.group(1))
                display_style = body_match.group(2) or None

            folded_style = (display_style or "").casefold()
            if folded_style.startswith(("heading", "title")):
                element_type = "heading"
            elif folded_style.startswith("list"):
                element_type = "list_item"
            else:
                element_type = "paragraph"

    folded_style = (display_style or "").casefold()
    list_type: str | None = None
    list_level: int | None = None
    if element_type == "list_item":
        list_type = (
            "ordered"
            if "number" in folded_style or "decimal" in folded_style
            else "bullet"
        )
        level_match = _LIST_LEVEL_SUFFIX.search(display_style or "")
        list_level = max(int(level_match.group(1)) - 1, 0) if level_match else 0

    block_attributes: dict[str, object] = {}
    if element_type == "heading":
        heading_match = _HEADING_LEVEL.fullmatch(display_style or "")
        if heading_match is not None:
            block_attributes["header"] = min(max(int(heading_match.group(1)), 1), 6)
    elif element_type == "list_item":
        block_attributes["list"] = list_type
        if list_level:
            block_attributes["indent"] = list_level

    return {
        "ordinal": ordinal,
        "element_type": element_type,
        "location_json": location,
        "formatting_json": {"style_name": display_style} if display_style else {},
        "list_type": list_type,
        "list_level": list_level,
        "delta_attributes": block_attributes,
    }


def _snapshot_values(element) -> dict:
    shape = _block_shape(element.style_name, element.paragraph_index)
    normalized_text = _normalise_text(element.text)
    structure_source = {
        "element_type": shape["element_type"],
        "list_type": shape["list_type"],
        "list_level": shape["list_level"],
        "location": shape["location_json"],
    }
    return {
        "element_id": element.id,
        "document_id": element.document_id,
        "ordinal": shape["ordinal"],
        "element_type": shape["element_type"],
        "text": element.text,
        "normalized_text": normalized_text,
        "exact_match_hash": _exact_match_hash(
            shape["element_type"],
            normalized_text,
        ),
        "structure_hash": hashlib.sha256(
            json.dumps(
                structure_source,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest(),
        "delta_json": {
            "ops": [
                {"insert": element.text},
                {
                    "insert": "\n",
                    **(
                        {"attributes": shape["delta_attributes"]}
                        if shape["delta_attributes"]
                        else {}
                    ),
                },
            ]
        },
        "formatting_json": shape["formatting_json"],
        "list_type": shape["list_type"],
        "list_level": shape["list_level"],
        "alignment": None,
        "location_json": shape["location_json"],
        "shared_state": "shared",
        "supported": True,
        "unsupported_reason": None,
    }


def _block_revision_id(version_id: str, element_id: str) -> str:
    return str(
        uuid5(
            NAMESPACE_URL,
            f"docsync:document-block-revision:{version_id}:{element_id}",
        )
    )


def _restore_before_text(state: dict[str, dict], targets) -> None:
    for target in targets:
        block = state.get(target.element_id)
        if block is None:
            continue
        before_text = target.before_text
        normalized_text = _normalise_text(before_text)
        block["text"] = before_text
        block["normalized_text"] = normalized_text
        block["exact_match_hash"] = _exact_match_hash(
            block["element_type"],
            normalized_text,
        )
        delta_json = dict(block["delta_json"])
        operations = [dict(item) for item in delta_json.get("ops", [])]
        if operations:
            operations[0]["insert"] = before_text
        delta_json["ops"] = operations
        block["delta_json"] = delta_json


def _backfill_document_versions(session: Session, document) -> tuple[list, object]:
    from .models import (
        DocumentHead,
        DocumentVersion,
        GeneratedVersion,
        GenerationJob,
    )

    versions = list(
        session.scalars(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.version_number, DocumentVersion.created_at)
        )
    )
    original = session.get(DocumentVersion, document.id)
    if original is not None and original.document_id != document.id:
        raise RuntimeError(
            "Cannot migrate document versions because an existing version ID "
            f"conflicts with document {document.id}."
        )
    if original is None:
        original = next(
            (
                version
                for version in versions
                if version.storage_area == "originals"
                and version.parent_version_id is None
            ),
            None,
        )
    if original is None:
        used_numbers = {version.version_number for version in versions}
        version_number = 1
        while version_number in used_numbers:
            version_number += 1
        original = DocumentVersion(
            id=document.id,
            document_id=document.id,
            parent_version_id=None,
            generation_id=None,
            version_number=version_number,
            storage_area="originals",
            storage_name=document.stored_name,
            download_name=document.original_name,
            checksum_sha256=document.checksum_sha256,
            created_at=document.created_at,
        )
        session.add(original)
        session.flush()
        versions.append(original)

    legacy_rows = session.execute(
        select(GeneratedVersion, GenerationJob)
        .join(GenerationJob, GeneratedVersion.generation_id == GenerationJob.id)
        .where(
            GeneratedVersion.source_document_id == document.id,
            GenerationJob.status == "completed",
        )
        .order_by(GenerationJob.created_at, GeneratedVersion.id)
    ).all()

    by_generation = {
        version.generation_id: version
        for version in versions
        if version.generation_id is not None
    }
    used_numbers = {version.version_number for version in versions}
    next_number = max(used_numbers, default=0) + 1
    parent = original
    for generated, generation in legacy_rows:
        version = by_generation.get(generation.id)
        if version is None:
            version = session.get(DocumentVersion, generated.id)
        if version is not None and version.document_id != document.id:
            raise RuntimeError(
                "Cannot migrate generated versions because an existing version ID "
                f"conflicts with legacy version {generated.id}."
            )
        if version is None:
            while next_number in used_numbers:
                next_number += 1
            version = DocumentVersion(
                id=generated.id,
                document_id=document.id,
                parent_version_id=parent.id,
                generation_id=generation.id,
                version_number=next_number,
                storage_area="generated",
                storage_name=generated.storage_name,
                download_name=generated.download_name,
                checksum_sha256=_stored_file_checksum(
                    "generated",
                    generated.storage_name,
                ),
                created_at=generation.created_at,
            )
            session.add(version)
            session.flush()
            versions.append(version)
            by_generation[generation.id] = version
            used_numbers.add(next_number)
            next_number += 1
        parent = version

    versions.sort(key=lambda item: (item.version_number, item.created_at, item.id))
    head = session.get(DocumentHead, document.id)
    if head is None:
        current_version = parent if legacy_rows else original
        head = DocumentHead(
            document_id=document.id,
            current_version_id=current_version.id,
            revision=max(current_version.version_number, 1),
        )
        session.add(head)
        session.flush()
    return versions, head


def _backfill_block_revisions(
    session: Session,
    document,
    versions: list,
    head,
) -> None:
    from .models import (
        DocumentBlockRevision,
        DocumentVersion,
        EditorOperationTarget,
        GenerationTarget,
    )

    versions_by_id = {version.id: version for version in versions}
    chain: list[DocumentVersion] = []
    seen: set[str] = set()
    current = versions_by_id.get(head.current_version_id)
    while current is not None and current.id not in seen:
        chain.append(current)
        seen.add(current.id)
        current = (
            versions_by_id.get(current.parent_version_id)
            if current.parent_version_id
            else None
        )

    if not chain:
        return

    elements = sorted(
        document.elements,
        key=lambda element: (
            _block_shape(element.style_name, element.paragraph_index)["ordinal"],
            element.paragraph_index,
            element.id,
        ),
    )
    state = {element.id: _snapshot_values(element) for element in elements}

    for version in chain:
        existing_element_ids = set(
            session.scalars(
                select(DocumentBlockRevision.element_id).where(
                    DocumentBlockRevision.version_id == version.id
                )
            )
        )
        for values in state.values():
            if values["element_id"] in existing_element_ids:
                continue
            session.add(
                DocumentBlockRevision(
                    id=_block_revision_id(version.id, values["element_id"]),
                    version_id=version.id,
                    **values,
                )
            )
        session.flush()

        if version.editor_operation_id is not None:
            editor_targets = session.scalars(
                select(EditorOperationTarget).where(
                    EditorOperationTarget.operation_id == version.editor_operation_id,
                    EditorOperationTarget.document_id == document.id,
                )
            )
            _restore_before_text(state, editor_targets)
        elif version.generation_id is not None:
            generation_targets = session.scalars(
                select(GenerationTarget).where(
                    GenerationTarget.generation_id == version.generation_id,
                    GenerationTarget.document_id == document.id,
                )
            )
            _restore_before_text(state, generation_targets)


def _version_foundation_is_complete(session: Session) -> bool:
    """Use indexed relational checks instead of rebuilding every block snapshot."""

    checks = (
        """
        SELECT 1
        FROM documents d
        LEFT JOIN document_versions v ON v.id = d.id AND v.document_id = d.id
        WHERE v.id IS NULL
        LIMIT 1
        """,
        """
        SELECT 1
        FROM documents d
        LEFT JOIN document_heads h ON h.document_id = d.id
        LEFT JOIN document_versions v
          ON v.id = h.current_version_id AND v.document_id = d.id
        WHERE h.document_id IS NULL OR v.id IS NULL
        LIMIT 1
        """,
        """
        SELECT 1
        FROM document_elements e
        JOIN document_versions v ON v.document_id = e.document_id
        LEFT JOIN document_block_revisions r
          ON r.version_id = v.id AND r.element_id = e.id
        WHERE r.id IS NULL
        LIMIT 1
        """,
        """
        SELECT 1
        FROM generated_versions g
        JOIN generation_jobs j ON j.id = g.generation_id
        LEFT JOIN document_versions v
          ON v.id = g.id
         AND v.document_id = g.source_document_id
         AND v.generation_id = g.generation_id
        WHERE j.status = 'completed' AND v.id IS NULL
        LIMIT 1
        """,
    )
    return all(session.execute(text(query)).first() is None for query in checks)


def _migrate_version_foundation(session: Session) -> None:
    if _version_foundation_is_complete(session):
        logger.warning("docsync.startup.version_foundation=already_complete")
        return
    _backfill_version_foundation(session)


def _backfill_version_foundation(session: Session) -> None:
    """Bridge pre-versioning SQLite databases during schema migration 1.

    The original document keeps its historical public ID. Legacy generated rows
    likewise keep their IDs, so existing links remain valid while every document
    gains an explicit lineage, current head, and immutable block snapshots.
    """

    from .models import DocumentRecord

    documents = session.scalars(
        select(DocumentRecord).order_by(
            DocumentRecord.created_at,
            DocumentRecord.id,
        )
    ).yield_per(25)
    for index, document in enumerate(documents, start=1):
        versions, head = _backfill_document_versions(session, document)
        _backfill_block_revisions(session, document, versions, head)
        if index % 25 == 0:
            session.flush()


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
