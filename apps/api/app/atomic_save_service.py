from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Union

from .audit_logger import AuditLogger
from .backup_service import DocumentBackupService
from .error_mapper import ErrorMapper, SaveValidationFailedError
from .path_service import SafePathService
from .storage_service import DocumentStorageService
from .validation_service import DocumentValidationService


class AtomicSaveService:
    """Coordinates pre-save backup, temporary write, package validation, atomic replacement, and rollback."""

    @classmethod
    def save_document(
        cls,
        working_file: Path,
        doc_id: str,
        content_or_writer: Union[bytes, Callable[[Path], None]],
    ) -> Path:
        """Atomically update a working document with full validation and rollback on failure (FR-10, FR-11, FR-12)."""
        workspace = DocumentStorageService.get_workspace_dir()
        SafePathService.ensure_contained(working_file, workspace)

        # Step 1: Pre-save backup of active valid version (FR-10)
        backup_file = None
        if working_file.exists():
            backup_file = DocumentBackupService.create_backup(working_file, doc_id)

        # Step 2: Write changes to unique temporary file (FR-11)
        temp_file = DocumentStorageService.create_temp_file(suffix=".docx")

        try:
            if callable(content_or_writer):
                content_or_writer(temp_file)
            elif isinstance(content_or_writer, bytes):
                temp_file.write_bytes(content_or_writer)
            else:
                raise ValueError("content_or_writer must be bytes or a callable taking a Path")

            # Step 3: Validate temporary DOCX package (FR-11, VR-10)
            DocumentValidationService.validate_file(temp_file, filename=working_file.name)

            # Step 4: Atomically replace working document (FR-11)
            # On Windows, os.replace handles atomic file replacement if temp_file and working_file are on same volume
            os.replace(temp_file, working_file)

            # Step 5: Post-save revalidation (FR-12)
            DocumentValidationService.validate_file(working_file, filename=working_file.name)

            AuditLogger.log_event(
                operation="save_document",
                file_id=doc_id,
                details=f"Successfully saved and validated working document '{working_file.name}'",
            )

            # Step 6: Prune old backups
            DocumentBackupService.prune_backups(doc_id)

            return working_file

        except Exception as exc:
            # Clean up temp file if it exists
            if temp_file.exists():
                try:
                    temp_file.unlink()
                except OSError:
                    pass

            # Rollback: Restore previous valid backup if active file was modified or deleted (FR-12)
            restored = False
            if backup_file and backup_file.exists():
                try:
                    DocumentBackupService.restore_latest_backup(working_file, doc_id)
                    restored = True
                except Exception as restore_exc:
                    AuditLogger.log_event(
                        operation="rollback_failed",
                        file_id=doc_id,
                        details=f"Backup restoration failed: {str(restore_exc)}",
                    )

            mapped_err = ErrorMapper.map_exception(exc)
            if not isinstance(mapped_err, SaveValidationFailedError):
                msg = f"Save validation failed: {mapped_err.message}"
                if restored:
                    msg += " Your previous version was restored."
                mapped_err = SaveValidationFailedError(message=msg)

            AuditLogger.log_event(
                operation="save_document_failed",
                file_id=doc_id,
                error_code=mapped_err.code,
                reference_id=mapped_err.reference_id,
                details=str(exc),
            )

            raise mapped_err from exc
