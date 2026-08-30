from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import sys
import zipfile

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from app.snapshot_service import SnapshotError, create_snapshot, promote_restored_workspace, restore_snapshot, verify_snapshot


USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
DEVICE = "33333333-3333-4333-8333-333333333333"


def workspace(root: Path, name: str = "workspace") -> Path:
    target = root / name
    target.mkdir(parents=True)
    with sqlite3.connect(target / "docsync.db") as connection:
        connection.execute("pragma journal_mode=wal")
        connection.execute("create table workspace_schema_migrations(version integer)")
        connection.execute("insert into workspace_schema_migrations values (9)")
        connection.execute("create table document_sets(id text primary key, name text)")
        connection.execute("insert into document_sets values ('one', 'Snapshot test')")
    connection.close()
    (target / "originals").mkdir(); (target / "generated" / "versions").mkdir(parents=True); (target / "renders").mkdir()
    (target / "originals" / "source.docx").write_bytes(b"document")
    (target / "generated" / "versions" / "immutable.docx").write_bytes(b"version")
    (target / "renders" / "preview.pdf").write_bytes(b"cache")
    return target


def snapshot(source: Path, account: Path):
    return create_snapshot(workspace=source, account_dir=account, user_id=USER_A, device_id=DEVICE, docsync_version="1.18.0", max_bytes=10_000_000)


def test_snapshot_uses_consistent_sqlite_backup_inventory_and_excludes_cache(tmp_path: Path):
    source = workspace(tmp_path); result = snapshot(source, tmp_path / "account")
    with zipfile.ZipFile(result.archive_path) as archive:
        names = set(archive.namelist()); manifest = json.loads(archive.read("manifest.json"))
        assert "workspace/docsync.db" in names
        assert "workspace/originals/source.docx" in names
        assert "workspace/generated/versions/immutable.docx" in names
        assert not any("renders" in name or "auth-session" in name or ".env" in name for name in names)
        assert manifest["user_id"] == USER_A and manifest["device_id"] == DEVICE and manifest["workspace_revision"] == 1
        extracted = tmp_path / "snapshot.db"; extracted.write_bytes(archive.read("workspace/docsync.db"))
    with sqlite3.connect(extracted) as connection:
        assert connection.execute("pragma integrity_check").fetchone()[0] == "ok"
        assert connection.execute("select name from document_sets").fetchone()[0] == "Snapshot test"


def test_snapshot_hash_size_limit_and_retention(tmp_path: Path):
    source = workspace(tmp_path); account = tmp_path / "account"; first = snapshot(source, account)
    assert verify_snapshot(first.archive_path, expected_sha256=first.sha256, max_bytes=10_000_000)["snapshot_id"] == first.snapshot_id
    first.archive_path.write_bytes(first.archive_path.read_bytes() + b"changed")
    with pytest.raises(SnapshotError, match="hash") as mismatch: verify_snapshot(first.archive_path, expected_sha256=first.sha256, max_bytes=10_000_000)
    assert mismatch.value.code == "restore_hash_mismatch"
    with pytest.raises(SnapshotError) as too_large: create_snapshot(workspace=source, account_dir=account, user_id=USER_A, device_id=DEVICE, docsync_version="1.18.0", max_bytes=1)
    assert too_large.value.code == "snapshot_too_large"


def test_snapshot_retention_does_not_include_prior_archives(tmp_path: Path):
    source = workspace(tmp_path); account = tmp_path / "account"
    first, second, third = snapshot(source, account), snapshot(source, account), snapshot(source, account)
    assert len(list((account / "snapshots").glob("*.zip"))) == 2
    with zipfile.ZipFile(third.archive_path) as archive:
        assert not any(name.endswith(".zip") for name in archive.namelist())
    assert second.workspace_revision == 2 and third.workspace_revision == 3 and first.workspace_revision == 1


@pytest.mark.parametrize("unsafe", ["../outside.txt", "..\\outside.txt", "C:\\outside.txt", "/absolute.txt"])
def test_restore_rejects_zip_slip_paths(tmp_path: Path, unsafe: str):
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as output: output.writestr("manifest.json", "{}"), output.writestr(unsafe, "bad")
    with pytest.raises(SnapshotError) as error: restore_snapshot(archive_path=archive, expected_sha256=__import__("hashlib").sha256(archive.read_bytes()).hexdigest(), account_dir=tmp_path / "account", user_id=USER_A, max_bytes=1_000_000)
    assert error.value.code == "restore_unsafe_path"
    assert not (tmp_path / "outside.txt").exists()


def test_restore_validates_owner_manifest_database_and_stages_without_touching_live_workspace(tmp_path: Path):
    source = workspace(tmp_path, "source"); account = tmp_path / "account"; result = snapshot(source, account)
    live = workspace(tmp_path, "live")
    with pytest.raises(SnapshotError) as wrong_user: restore_snapshot(archive_path=result.archive_path, expected_sha256=result.sha256, account_dir=account, user_id=USER_B, max_bytes=10_000_000)
    assert wrong_user.value.code == "restore_wrong_user" and (live / "originals" / "source.docx").exists()
    staged = restore_snapshot(archive_path=result.archive_path, expected_sha256=result.sha256, account_dir=account, user_id=USER_A, max_bytes=10_000_000)
    assert (staged / "originals" / "source.docx").read_bytes() == b"document"
    assert (live / "originals" / "source.docx").exists()


def test_missing_manifest_unsupported_version_and_corrupt_database_are_rejected(tmp_path: Path):
    source = workspace(tmp_path); account = tmp_path / "account"; result = snapshot(source, account)
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as output: output.writestr("workspace/docsync.db", b"not sqlite")
    with pytest.raises(SnapshotError) as missing: restore_snapshot(archive_path=bad, expected_sha256=__import__("hashlib").sha256(bad.read_bytes()).hexdigest(), account_dir=account, user_id=USER_A, max_bytes=10_000_000)
    assert missing.value.code == "restore_manifest_invalid"
    future_archive = tmp_path / "future.zip"
    with zipfile.ZipFile(result.archive_path) as source, zipfile.ZipFile(future_archive, "w") as output:
        for member in source.infolist():
            value = source.read(member)
            if member.filename == "manifest.json":
                manifest = json.loads(value); manifest["manifest_schema_version"] = 999; value = json.dumps(manifest).encode()
            output.writestr(member.filename, value)
    with pytest.raises(SnapshotError) as future: restore_snapshot(archive_path=future_archive, expected_sha256=None, account_dir=account, user_id=USER_A, max_bytes=10_000_000)
    assert future.value.code == "restore_manifest_invalid"


def test_restore_promotion_rolls_back_when_activation_fails(tmp_path: Path):
    live = workspace(tmp_path, "live"); staged = workspace(tmp_path, "staged")
    (live / "originals" / "source.docx").write_bytes(b"old")
    (staged / "originals" / "source.docx").write_bytes(b"new")
    with pytest.raises(SnapshotError) as failure:
        promote_restored_workspace(staged_workspace=staged, workspace=live, activate=lambda _: (_ for _ in ()).throw(RuntimeError("no")))
    assert failure.value.code == "restore_promotion_failed"
    assert (live / "originals" / "source.docx").read_bytes() == b"old"
