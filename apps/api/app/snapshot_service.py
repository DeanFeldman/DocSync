"""Offline, account-scoped DocSync workspace snapshot and restore engine.

Snapshots contain the consistent SQLite database plus ``originals`` and
``generated`` document storage. Rendered previews, logs, temporary files and
all account/session configuration are deliberately excluded. This module has no
network, Supabase, Electron, or UI dependency so a later provider can reuse it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
from uuid import UUID, uuid4
import zipfile


MANIFEST_SCHEMA_VERSION = 1
DATABASE_NAME = "docsync.db"
INCLUDED_DIRECTORIES = ("originals", "generated")
EXCLUDED_NAMES = {"renders", "logs", "temp", "backups", "migration-backups", "snapshot-temp", "restore-temp", "snapshots", "pre-restore-backup"}
MAX_FILES = 20_000
MAX_ENTRY_BYTES = 512 * 1024 * 1024


class SnapshotError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SnapshotResult:
    snapshot_id: str
    archive_path: Path
    sha256: str
    archive_size_bytes: int
    workspace_revision: int


def _uuid(value: str, field: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError) as error:
        raise SnapshotError("snapshot_manifest_invalid", f"{field} must be a UUID.") from error


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _state_path(account_dir: Path) -> Path:
    return account_dir / "snapshots" / "snapshot-state.json"


def _next_revision(account_dir: Path) -> int:
    try:
        return int(json.loads(_state_path(account_dir).read_text("utf-8")).get("workspace_revision", 0)) + 1
    except (OSError, ValueError, json.JSONDecodeError):
        return 1


def _write_state(account_dir: Path, result: SnapshotResult) -> None:
    target = _state_path(account_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"workspace_revision": result.workspace_revision, "latest_snapshot_id": result.snapshot_id}, indent=2), "utf-8")


def _database_schema_version(database: Path) -> int:
    try:
        with sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True) as connection:
            value = connection.execute("SELECT MAX(version) FROM workspace_schema_migrations").fetchone()[0]
            return int(value or 0)
    except sqlite3.Error as error:
        raise SnapshotError("snapshot_database_backup_failed", "The workspace database could not be opened.") from error


def _backup_database(source: Path, destination: Path) -> int:
    if not source.is_file():
        raise SnapshotError("snapshot_database_backup_failed", "The workspace database is missing.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sqlite3.connect(source) as live, sqlite3.connect(destination) as backup:
            live.backup(backup)
        with sqlite3.connect(f"file:{destination.as_posix()}?mode=ro", uri=True) as check:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SnapshotError("snapshot_database_backup_failed", "The database backup failed integrity validation.")
        return _database_schema_version(destination)
    except SnapshotError:
        raise
    except sqlite3.Error as error:
        raise SnapshotError("snapshot_database_backup_failed", "A consistent database backup could not be created.") from error


def _included_files(workspace: Path) -> list[Path]:
    files: list[Path] = []
    for name in INCLUDED_DIRECTORIES:
        directory = workspace / name
        if directory.exists():
            if not directory.is_dir():
                raise SnapshotError("snapshot_file_copy_failed", "A required workspace storage location is invalid.")
            files.extend(path for path in directory.rglob("*") if path.is_file())
    return sorted(files, key=lambda item: item.relative_to(workspace).as_posix())


def _copy_workspace_payload(workspace: Path, staged_workspace: Path, limit: int) -> tuple[list[dict[str, object]], int]:
    inventory: list[dict[str, object]] = []
    total = 0
    for source in _included_files(workspace):
        relative = source.relative_to(workspace)
        if any(part in EXCLUDED_NAMES or part.endswith(("-wal", "-shm")) for part in relative.parts):
            continue
        size = source.stat().st_size
        total += size
        if total > limit:
            raise SnapshotError("snapshot_too_large", "The selected workspace data exceeds the configured snapshot limit.")
        target = staged_workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        inventory.append({"relative_path": relative.as_posix(), "size_bytes": size, "sha256": _hash_file(target)})
    return inventory, total


def _estimate_workspace_bytes(workspace: Path) -> int:
    database = workspace / DATABASE_NAME
    if not database.is_file():
        raise SnapshotError("snapshot_database_backup_failed", "The workspace database is missing.")
    return database.stat().st_size + sum(path.stat().st_size for path in _included_files(workspace))


def _safe_zip_members(archive: zipfile.ZipFile, maximum_bytes: int) -> list[zipfile.ZipInfo]:
    members = archive.infolist()
    if len(members) > MAX_FILES:
        raise SnapshotError("restore_invalid_archive", "The archive contains too many entries.")
    total = 0
    for member in members:
        name = member.filename.replace("\\", "/")
        pure = PurePosixPath(name)
        mode = member.external_attr >> 16
        if name.startswith("/") or name.startswith("//") or ":" in pure.parts[0] or ".." in pure.parts or stat.S_ISLNK(mode):
            raise SnapshotError("restore_unsafe_path", "The archive contains an unsafe path.")
        if member.file_size > MAX_ENTRY_BYTES:
            raise SnapshotError("restore_invalid_archive", "The archive contains an oversized entry.")
        total += member.file_size
        if total > maximum_bytes:
            raise SnapshotError("restore_invalid_archive", "The archive exceeds the restore size limit.")
    return members


def _validate_manifest(manifest: object, user_id: str) -> dict[str, object]:
    if not isinstance(manifest, dict) or manifest.get("manifest_schema_version") != MANIFEST_SCHEMA_VERSION:
        raise SnapshotError("restore_manifest_invalid", "The snapshot manifest is unsupported.")
    for field in ("snapshot_id", "user_id", "device_id"):
        _uuid(str(manifest.get(field, "")), field)
    if manifest["user_id"] != _uuid(user_id, "user_id"):
        raise SnapshotError("restore_wrong_user", "This snapshot belongs to a different DocSync account.")
    if not isinstance(manifest.get("files"), list) or not isinstance(manifest.get("workspace_revision"), int):
        raise SnapshotError("restore_manifest_invalid", "The snapshot manifest is incomplete.")
    return manifest


def _validate_restored_workspace(workspace: Path, manifest: dict[str, object]) -> None:
    database = workspace / DATABASE_NAME
    try:
        with sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SnapshotError("restore_database_invalid", "The restored database did not pass integrity validation.")
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_sets'").fetchone() is None:
                raise SnapshotError("restore_database_invalid", "The restored database is not a DocSync workspace.")
    except SnapshotError:
        raise
    except sqlite3.Error as error:
        raise SnapshotError("restore_database_invalid", "The restored database could not be opened.") from error
    expected = {str(item.get("relative_path")): item for item in manifest["files"] if isinstance(item, dict)}
    for relative, item in expected.items():
        candidate = workspace / relative
        if not candidate.is_file() or candidate.stat().st_size != item.get("size_bytes") or _hash_file(candidate) != item.get("sha256"):
            raise SnapshotError("restore_manifest_invalid", "A restored workspace file does not match its manifest.")


def create_snapshot(*, workspace: Path, account_dir: Path, user_id: str, device_id: str, docsync_version: str, max_bytes: int) -> SnapshotResult:
    user_id, device_id = _uuid(user_id, "user_id"), _uuid(device_id, "device_id")
    snapshot_id = str(uuid4()); revision = _next_revision(account_dir)
    temp = account_dir / "snapshot-temp" / snapshot_id; staged = temp / "workspace"; output = account_dir / "snapshots"; temporary_archive = temp / f"{snapshot_id}.zip"
    try:
        if _estimate_workspace_bytes(workspace) > max_bytes:
            raise SnapshotError("snapshot_too_large", "The selected workspace data exceeds the configured snapshot limit.")
        schema_version = _backup_database(workspace / DATABASE_NAME, staged / DATABASE_NAME)
        inventory, total = _copy_workspace_payload(workspace, staged, max_bytes)
        database = staged / DATABASE_NAME
        inventory.insert(0, {"relative_path": DATABASE_NAME, "size_bytes": database.stat().st_size, "sha256": _hash_file(database)})
        total += database.stat().st_size
        manifest = {"manifest_schema_version": MANIFEST_SCHEMA_VERSION, "snapshot_id": snapshot_id, "docsync_version": docsync_version, "created_at": datetime.now(UTC).isoformat(), "user_id": user_id, "device_id": device_id, "base_snapshot_id": None, "workspace_revision": revision, "database_schema_version": schema_version, "file_count": len(inventory), "total_uncompressed_bytes": total, "files": inventory}
        (temp / "manifest.json").write_text(json.dumps(manifest, sort_keys=True), "utf-8")
        with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(temp / "manifest.json", "manifest.json")
            for entry in inventory: archive.write(staged / str(entry["relative_path"]), f"workspace/{entry['relative_path']}")
        verify_snapshot(temporary_archive, expected_sha256=None, max_bytes=max_bytes)
        output.mkdir(parents=True, exist_ok=True); destination = output / f"{snapshot_id}.zip"; shutil.move(str(temporary_archive), destination)
        result = SnapshotResult(snapshot_id, destination, _hash_file(destination), destination.stat().st_size, revision); _write_state(account_dir, result)
        archives = sorted(output.glob("*.zip"), key=lambda item: item.stat().st_mtime, reverse=True)
        for old in archives[2:]: old.unlink()
        return result
    except SnapshotError:
        raise
    except OSError as error:
        raise SnapshotError("snapshot_archive_failed", "The local snapshot could not be created.") from error
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def inspect_snapshot(archive_path: Path, *, max_bytes: int) -> dict[str, object]:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            _safe_zip_members(archive, max_bytes)
            try: manifest = json.loads(archive.read("manifest.json"))
            except (KeyError, json.JSONDecodeError) as error: raise SnapshotError("restore_manifest_invalid", "The snapshot manifest is missing or invalid.") from error
            return manifest
    except SnapshotError: raise
    except (OSError, zipfile.BadZipFile) as error: raise SnapshotError("restore_invalid_archive", "The snapshot archive is invalid.") from error


def verify_snapshot(archive_path: Path, *, expected_sha256: str | None, max_bytes: int) -> dict[str, object]:
    if expected_sha256 is not None and _hash_file(archive_path) != expected_sha256:
        raise SnapshotError("restore_hash_mismatch", "The snapshot archive hash does not match.")
    return inspect_snapshot(archive_path, max_bytes=max_bytes)


def restore_snapshot(*, archive_path: Path, expected_sha256: str, account_dir: Path, user_id: str, max_bytes: int) -> Path:
    manifest = verify_snapshot(archive_path, expected_sha256=expected_sha256, max_bytes=max_bytes); manifest = _validate_manifest(manifest, user_id)
    target = account_dir / "restore-temp" / str(manifest["snapshot_id"]); shutil.rmtree(target, ignore_errors=True); target.mkdir(parents=True)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for member in _safe_zip_members(archive, max_bytes):
                if member.is_dir() or member.filename == "manifest.json": continue
                if not member.filename.startswith("workspace/") or member.filename.endswith((".exe", ".dll", ".ps1", ".bat", ".cmd")):
                    raise SnapshotError("restore_unsafe_path", "The archive contains unsupported workspace content.")
                destination = target / PurePosixPath(member.filename).relative_to("workspace")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("wb") as output: shutil.copyfileobj(source, output)
        _validate_restored_workspace(target, manifest)
        return target
    except SnapshotError:
        shutil.rmtree(target, ignore_errors=True); raise


def promote_restored_workspace(*, staged_workspace: Path, workspace: Path, activate: callable) -> None:
    backup = workspace.parent / "pre-restore-backup"
    shutil.rmtree(backup, ignore_errors=True)
    try:
        workspace.rename(backup)
        staged_workspace.rename(workspace)
        activate(workspace)
    except Exception as error:
        if workspace.exists():
            shutil.rmtree(workspace)
        if backup.exists():
            backup.rename(workspace)
        try:
            activate(workspace)
        except Exception:
            # The filesystem rollback is complete even if a caller's optional
            # activation probe also fails; never remove the known-good backup.
            pass
        raise SnapshotError("restore_promotion_failed", "The restored workspace could not be activated; the previous workspace was restored.") from error
    else:
        shutil.rmtree(backup, ignore_errors=True)
