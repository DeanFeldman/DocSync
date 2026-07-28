from __future__ import annotations

from collections.abc import Callable, Sequence
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from sqlalchemy import Engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session


SCHEMA_TABLE = "docsync_schema_migrations"
BACKUP_RETENTION = 5


@dataclass(frozen=True)
class WorkspaceMigration:
    version: int
    name: str
    apply: Callable[[Session], None]


@dataclass(frozen=True)
class MigrationResult:
    previous_version: int
    current_version: int
    applied_versions: tuple[int, ...]
    backup_path: Path | None


class WorkspaceMigrationError(RuntimeError):
    def __init__(self, message: str, *, backup_path: Path | None = None):
        super().__init__(message)
        self.backup_path = backup_path


def sqlite_database_path(database_url: str) -> Path:
    url = make_url(database_url)
    if url.get_backend_name() != "sqlite" or not url.database:
        raise WorkspaceMigrationError(
            "DocSync workspace migrations require a file-backed SQLite database."
        )
    if url.database == ":memory:":
        raise WorkspaceMigrationError(
            "DocSync workspace migrations cannot use an in-memory database."
        )
    return Path(url.database).resolve()


def detect_schema_version(database_path: Path) -> int:
    if not database_path.is_file() or database_path.stat().st_size == 0:
        return 0

    with closing(sqlite3.connect(database_path)) as connection:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (SCHEMA_TABLE,),
        ).fetchone()
        if table is None:
            return 0
        row = connection.execute(
            f"SELECT MAX(version) FROM {SCHEMA_TABLE}"
        ).fetchone()
        return int(row[0] or 0)


def _has_persisted_schema(database_path: Path) -> bool:
    if not database_path.is_file() or database_path.stat().st_size == 0:
        return False
    with closing(sqlite3.connect(database_path)) as connection:
        row = connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name != ?
            LIMIT 1
            """,
            (SCHEMA_TABLE,),
        ).fetchone()
        return row is not None


def _verify_backup(backup_path: Path) -> None:
    if not backup_path.is_file() or backup_path.stat().st_size == 0:
        raise WorkspaceMigrationError(
            "The pre-migration workspace backup was not created or is empty."
        )
    with closing(sqlite3.connect(backup_path)) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()
    if result is None or result[0] != "ok":
        raise WorkspaceMigrationError(
            "The pre-migration workspace backup did not pass its integrity check."
        )


def create_verified_backup(
    database_path: Path,
    backup_directory: Path,
    target_schema_version: int,
    *,
    retention: int = BACKUP_RETENTION,
) -> Path:
    backup_path: Path | None = None
    try:
        backup_directory.mkdir(parents=True, exist_ok=True)
        if backup_directory.resolve() == database_path.parent.resolve():
            raise WorkspaceMigrationError(
                "The migration backup directory must be separate from the active database."
            )

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        backup_path = backup_directory / (
            f"{database_path.stem}-before-schema-{target_schema_version}-{timestamp}.db"
        )
        with (
            closing(sqlite3.connect(database_path)) as source,
            closing(sqlite3.connect(backup_path)) as destination,
        ):
            source.backup(destination)
            destination.commit()
        _verify_backup(backup_path)
    except Exception as exc:
        if backup_path is not None:
            backup_path.unlink(missing_ok=True)
        detail = str(exc)
        raise WorkspaceMigrationError(
            "DocSync could not create and verify the pre-migration workspace "
            f"backup: {detail} No migration was run and the active workspace "
            "was not changed."
        ) from exc

    assert backup_path is not None
    backups = sorted(
        backup_directory.glob(f"{database_path.stem}-before-schema-*.db"),
        key=lambda item: item.stat().st_mtime_ns,
        reverse=True,
    )
    for expired in backups[max(retention, 1) :]:
        if expired.resolve() != database_path.resolve():
            expired.unlink(missing_ok=True)
    return backup_path


def _validate_migrations(migrations: Sequence[WorkspaceMigration]) -> None:
    versions = [migration.version for migration in migrations]
    if versions != sorted(versions) or len(versions) != len(set(versions)):
        raise WorkspaceMigrationError(
            "Workspace migration identifiers must be unique and monotonically increasing."
        )
    if any(version < 1 for version in versions):
        raise WorkspaceMigrationError(
            "Workspace migration identifiers must be positive integers."
        )


def _restore_active_database(
    engine: Engine,
    database_path: Path,
    backup_path: Path,
) -> None:
    engine.dispose()
    for suffix in ("-wal", "-shm"):
        Path(f"{database_path}{suffix}").unlink(missing_ok=True)
    with (
        closing(sqlite3.connect(backup_path)) as source,
        closing(sqlite3.connect(database_path)) as destination,
    ):
        source.backup(destination)
        destination.commit()


def run_workspace_migrations(
    *,
    engine: Engine,
    database_url: str,
    backup_directory: Path,
    create_schema: Callable[[object], None],
    migrations: Sequence[WorkspaceMigration],
    report_stage: Callable[[str], None] | None = None,
) -> MigrationResult:
    _validate_migrations(migrations)
    database_path = sqlite_database_path(database_url)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    previous_version = detect_schema_version(database_path)
    latest_version = migrations[-1].version if migrations else 0
    if previous_version > latest_version:
        raise WorkspaceMigrationError(
            "This workspace was created by a newer DocSync schema and cannot be "
            "opened safely by this version."
        )

    pending = [
        migration for migration in migrations if migration.version > previous_version
    ]
    if not pending:
        return MigrationResult(
            previous_version=previous_version,
            current_version=previous_version,
            applied_versions=(),
            backup_path=None,
        )

    backup_path: Path | None = None
    if _has_persisted_schema(database_path):
        if report_stage is not None:
            report_stage("backing_up_workspace")
        backup_path = create_verified_backup(
            database_path,
            backup_directory,
            pending[0].version,
        )

    applied: list[int] = []
    try:
        for migration in pending:
            if report_stage is not None:
                report_stage(f"applying_schema_{migration.version}")
            with engine.begin() as connection:
                create_schema(connection)
                connection.exec_driver_sql(
                    f"""
                    CREATE TABLE IF NOT EXISTS {SCHEMA_TABLE} (
                        version INTEGER NOT NULL PRIMARY KEY,
                        name VARCHAR(200) NOT NULL,
                        applied_at VARCHAR(40) NOT NULL
                    )
                    """
                )
                session = Session(bind=connection, autoflush=False)
                try:
                    migration.apply(session)
                    session.flush()
                finally:
                    session.close()
                connection.exec_driver_sql(
                    f"""
                    INSERT INTO {SCHEMA_TABLE} (version, name, applied_at)
                    VALUES (?, ?, ?)
                    """,
                    (
                        migration.version,
                        migration.name,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
            applied.append(migration.version)
    except Exception as exc:
        if backup_path is not None:
            _restore_active_database(engine, database_path, backup_path)
            detail = (
                "The active workspace was restored to its original state. "
                f"Recovery backup: {backup_path}"
            )
        else:
            engine.dispose()
            detail = "The active workspace transaction was rolled back."
        raise WorkspaceMigrationError(
            f"DocSync could not migrate the workspace. {detail}",
            backup_path=backup_path,
        ) from exc

    return MigrationResult(
        previous_version=previous_version,
        current_version=applied[-1] if applied else previous_version,
        applied_versions=tuple(applied),
        backup_path=backup_path,
    )
