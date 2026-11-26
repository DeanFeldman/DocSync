"""Portable, account-free backups of a local DocSync workspace."""

from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
from tempfile import TemporaryDirectory
from uuid import uuid4
import zipfile

from .filesystem import disk_path as _disk_path
from .snapshot_service import (
    DATABASE_NAME,
    INCLUDED_DIRECTORIES,
    MAX_FILES,
    SnapshotError,
    _backup_database,
    _database_schema_version,
    _hash_file,
    _included_files,
    _safe_zip_members,
)


FORMAT = "docsync-workspace"
VERSION = 1
APPEARANCES = {"system", "light", "dark"}
SAFE_SEGMENT = re.compile(r'[^<>:"/\\|?*\x00-\x1f]+')
WINDOWS_DEVICE = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)


def _workspace_path(name: object) -> str:
    if name == DATABASE_NAME:
        return DATABASE_NAME
    if not isinstance(name, str):
        raise SnapshotError("invalid_path", "The backup contains an invalid path.")
    parts = name.split("/")
    if (
        len(parts) < 2
        or parts[0] not in INCLUDED_DIRECTORIES
        or not name.lower().endswith((".docx", ".zip"))
        or any(
            not SAFE_SEGMENT.fullmatch(part)
            or part.endswith((".", " "))
            or WINDOWS_DEVICE.match(part)
            for part in parts
        )
    ):
        raise SnapshotError("invalid_path", "The backup contains an unsupported workspace path.")
    return name


def _inspect_workspace(
    workspace: Path, schema_version: int, files: dict[str, dict]
) -> dict[str, int]:
    database = workspace / DATABASE_NAME
    if _database_schema_version(database) != schema_version:
        raise SnapshotError("unsupported_schema", "The backup uses an incompatible workspace database.")
    try:
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise SnapshotError("invalid_database", "The backup database failed its integrity check.")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise SnapshotError("invalid_database", "The backup database has broken relationships.")
            for area, name, checksum in connection.execute(
                "SELECT storage_area, storage_name, checksum_sha256 FROM document_versions"
            ):
                relative = _workspace_path(f"{area}/{name}")
                entry = files.get(relative)
                if entry is None or (checksum and checksum != entry["sha256"]):
                    raise SnapshotError("missing_document", "A document version is missing or damaged.")
            for (name,) in connection.execute("SELECT stored_name FROM documents"):
                if _workspace_path(f"originals/{name}") not in files:
                    raise SnapshotError("missing_document", "An original document is missing.")
            return {
                "sets": connection.execute("SELECT COUNT(*) FROM document_sets").fetchone()[0],
                "documents": connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
                "versions": connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0],
            }
    except sqlite3.Error as error:
        raise SnapshotError("invalid_database", "The backup is missing required workspace records.") from error


def _write_file(archive: zipfile.ZipFile, name: str, source: Path, limit: int) -> dict:
    digest = hashlib.sha256()
    size = 0
    with _disk_path(source).open("rb") as input_file, archive.open(name, "w", force_zip64=True) as output:
        while chunk := input_file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise SnapshotError("snapshot_too_large", "The workspace exceeds the backup size limit.")
            digest.update(chunk)
            output.write(chunk)
    return {"size": size, "sha256": digest.hexdigest()}


def export_device_workspace(
    workspace: Path, target: Path, *, appearance: str, max_bytes: int,
    database_path: Path | None = None,
) -> None:
    with TemporaryDirectory(dir=target.parent, prefix="db-") as temporary:
        staged = Path(temporary)
        schema = _backup_database(database_path or workspace / DATABASE_NAME, staged / DATABASE_NAME)
        sources = [(DATABASE_NAME, staged / DATABASE_NAME)]
        long_workspace = _disk_path(workspace)
        sources.extend(
            (source.relative_to(long_workspace).as_posix(), source)
            for source in _included_files(long_workspace)
        )
        if len(sources) >= MAX_FILES:
            raise SnapshotError("too_many_files", "This workspace exceeds the file limit for a backup.")
        files: dict[str, dict] = {}
        total = 0
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            for name, source in sources:
                relative = _workspace_path(name)
                allowed = staged if name == DATABASE_NAME else workspace
                if source.is_symlink() or not _disk_path(source.resolve()).is_relative_to(_disk_path(allowed.resolve())):
                    raise SnapshotError("invalid_path", "The workspace contains a file outside its storage folders.")
                files[relative] = _write_file(archive, relative, source, max_bytes - total)
                total += files[relative]["size"]
            _inspect_workspace(staged, schema, files)
            manifest = {
                "format": FORMAT, "version": VERSION, "database_schema_version": schema,
                "appearance": appearance, "files": files,
            }
            archive.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
            _safe_zip_members(archive, max_bytes)


def stage_device_import(
    archive_path: Path, staging_root: Path, *, schema_version: int, max_bytes: int
) -> dict:
    import_id = str(uuid4())
    staged = staging_root / import_id
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = _safe_zip_members(archive, max_bytes)
            lookup = {}
            for item in members:
                name = item.filename
                if name != "manifest.json":
                    _workspace_path(name)
                if item.is_dir() or "\\" in name or name.casefold() in lookup:
                    raise SnapshotError("invalid_archive", "The backup contains duplicate or invalid entries.")
                lookup[name.casefold()] = item
            manifest_member = lookup.get("manifest.json")
            if (
                manifest_member is None
                or manifest_member.filename != "manifest.json"
                or manifest_member.file_size > 8 * 1024 * 1024
            ):
                raise SnapshotError("invalid_manifest", "The backup manifest is missing or too large.")
            manifest = json.loads(archive.read(manifest_member))
            supported_schemas = (9, 10) if schema_version == 10 else (schema_version,)
            if (
                not isinstance(manifest, dict)
                or manifest.get("format") != FORMAT
                or manifest.get("version") != VERSION
                or manifest.get("database_schema_version") not in supported_schemas
                or manifest.get("appearance") not in tuple(APPEARANCES)
                or not isinstance(manifest.get("files"), dict)
            ):
                raise SnapshotError("invalid_manifest", "This backup is incompatible with this version of DocSync.")
            files = manifest["files"]
            expected = set(files) | {"manifest.json"}
            if DATABASE_NAME not in files or expected != {item.filename for item in members}:
                raise SnapshotError("invalid_manifest", "The backup is incomplete.")
            staged.mkdir(parents=True, exist_ok=False)
            for name, details in files.items():
                relative = _workspace_path(name)
                member = lookup[relative.casefold()]
                if not isinstance(details, dict) or member.file_size != details.get("size"):
                    raise SnapshotError("invalid_manifest", "A file has an invalid size.")
                destination = _disk_path(staged / relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if _hash_file(destination) != details.get("sha256"):
                    raise SnapshotError("invalid_checksum", "A file did not match its backup checksum.")
            summary = _inspect_workspace(staged, manifest["database_schema_version"], files)
        (staged / "import-settings.json").write_text(
            json.dumps({"appearance": manifest["appearance"]}), encoding="utf-8"
        )
        return {"import_id": import_id, **summary}
    except (SnapshotError, OSError, ValueError, RuntimeError, IndexError, zipfile.BadZipFile) as error:
        shutil.rmtree(_disk_path(staged), ignore_errors=True)
        if isinstance(error, SnapshotError):
            raise
        raise SnapshotError("invalid_archive", "The selected file is not a valid DocSync backup.") from error
