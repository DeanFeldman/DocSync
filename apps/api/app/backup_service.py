from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from .audit_logger import AuditLogger
from .path_service import SafePathService
from .storage_service import DocumentStorageService
from .validation_service import DocumentValidationService


class DocumentBackupService:
    """Creates backups, restores versions and applies retention rules."""

    @classmethod
    def get_document_backup_dir(cls, doc_id: str) -> Path:
        safe_doc_id = SafePathService.normalise_filename(doc_id)
        backup_dir = DocumentStorageService.get_backups_dir() / safe_doc_id
        backup_dir.mkdir(parents=True, exist_ok=True)
        SafePathService.ensure_contained(backup_dir, DocumentStorageService.get_backups_dir())
        return backup_dir

    @classmethod
    def create_backup(cls, working_file: Path, doc_id: str) -> Path | None:
        """Create a backup copy of the current valid document before replacement (FR-10)."""
        if not working_file.exists():
            return None

        # Verify source file is contained
        SafePathService.ensure_contained(working_file, DocumentStorageService.get_workspace_dir())

        backup_dir = cls.get_document_backup_dir(doc_id)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        safe_filename = SafePathService.normalise_filename(working_file.name)
        backup_file = backup_dir / f"{timestamp}_{safe_filename}"

        SafePathService.ensure_contained(backup_file, backup_dir)
        shutil.copy2(working_file, backup_file)

        AuditLogger.log_event(
            operation="create_backup",
            file_id=doc_id,
            details=f"Created backup '{backup_file.name}' for document '{working_file.name}'",
        )

        cls.prune_backups(doc_id)
        return backup_file

    @classmethod
    def list_backups(cls, doc_id: str) -> list[dict]:
        """List all available valid backups for a document ordered by newest first (FR-16)."""
        backup_dir = cls.get_document_backup_dir(doc_id)
        backups = []
        for file_path in sorted(backup_dir.glob("*.docx"), reverse=True):
            if file_path.is_file():
                stat = file_path.stat()
                backups.append(
                    {
                        "filename": file_path.name,
                        "path": str(file_path),
                        "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                        "size_bytes": stat.st_size,
                    }
                )
        return backups

    @classmethod
    def restore_latest_backup(cls, working_file: Path, doc_id: str) -> Path:
        """Restore the latest valid backup to working_file (FR-12, FR-16)."""
        backups = cls.list_backups(doc_id)
        if not backups:
            raise RuntimeError(f"No backup available to restore for document ID '{doc_id}'.")

        latest_backup_path = Path(backups[0]["path"])
        # Validate backup file before restoring
        DocumentValidationService.validate_file(latest_backup_path, filename=latest_backup_path.name)

        # Restore atomically
        shutil.copy2(latest_backup_path, working_file)

        AuditLogger.log_event(
            operation="restore_latest_backup",
            file_id=doc_id,
            details=f"Restored working file '{working_file.name}' from backup '{latest_backup_path.name}'",
        )

        return working_file

    @classmethod
    def prune_backups(cls, doc_id: str, max_retention: int = 10) -> int:
        """Prune older backups beyond max_retention count (SEC-09)."""
        backup_dir = cls.get_document_backup_dir(doc_id)
        backup_files = sorted(backup_dir.glob("*.docx"), key=lambda p: p.stat().st_mtime, reverse=True)

        pruned_count = 0
        if len(backup_files) > max_retention:
            for old_backup in backup_files[max_retention:]:
                try:
                    old_backup.unlink()
                    pruned_count += 1
                except OSError:
                    pass

        if pruned_count > 0:
            AuditLogger.log_event(
                operation="prune_backups",
                file_id=doc_id,
                details=f"Pruned {pruned_count} old backup(s) for document ID '{doc_id}'",
            )

        return pruned_count
