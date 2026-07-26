from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Union

from .audit_logger import AuditLogger
from .config import settings
from .path_service import SafePathService
from .validation_service import DocumentValidationService


class DocumentStorageService:
    """Manages workspace, backup, temporary, and log directories and working file creation."""

    @classmethod
    def get_workspace_dir(cls) -> Path:
        p = settings.data_dir / "workspace"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    def get_backups_dir(cls) -> Path:
        p = settings.data_dir / "backups"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    def get_temp_dir(cls) -> Path:
        p = settings.data_dir / "temp"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    def get_logs_dir(cls) -> Path:
        p = settings.data_dir / "logs"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    def init_storage(cls) -> None:
        """Initialize and verify application-controlled directories."""
        cls.get_workspace_dir()
        cls.get_backups_dir()
        cls.get_temp_dir()
        cls.get_logs_dir()

    @classmethod
    def generate_unique_filename(cls, directory: Path, filename: str) -> str:
        """Ensure filename does not overwrite an existing file in directory (FR-09)."""
        safe_name = SafePathService.normalise_filename(filename)
        target = directory / safe_name
        if not target.exists():
            return safe_name

        stem = Path(safe_name).stem
        ext = Path(safe_name).suffix
        counter = 1
        while True:
            candidate = f"{stem} ({counter}){ext}"
            if not (directory / candidate).exists():
                return candidate
            counter += 1

    @classmethod
    def create_working_copy(
        cls,
        source: Union[Path, bytes],
        original_filename: str = "document.docx",
    ) -> tuple[Path, str, bytes]:
        """Validate and create a working copy inside workspace directory (FR-08)."""
        # Step 1: Validate payload/file
        payload = DocumentValidationService.validate_file(source, filename=original_filename)

        # Step 2: Safe path / unique filename in workspace
        workspace = cls.get_workspace_dir()
        unique_name = cls.generate_unique_filename(workspace, original_filename)
        working_file = workspace / unique_name

        # Ensure containment
        SafePathService.ensure_contained(working_file, workspace)

        # Step 3: Write payload
        working_file.write_bytes(payload)

        AuditLogger.log_event(
            operation="create_working_copy",
            file_id=unique_name,
            details=f"Created working copy for '{original_filename}' ({len(payload)} bytes)",
        )

        return working_file, unique_name, payload

    @classmethod
    def create_temp_file(cls, suffix: str = ".docx") -> Path:
        """Create an unpredictable temporary file path inside temp directory (SEC-08)."""
        temp_dir = cls.get_temp_dir()
        unique_id = uuid.uuid4().hex
        temp_file = temp_dir / f"tmp_{unique_id}{suffix}"
        SafePathService.ensure_contained(temp_file, temp_dir)
        return temp_file

    @classmethod
    def cleanup_stale_temp_files(cls, max_age_seconds: int = 3600) -> int:
        """Clean stale temporary files on startup (FR-15)."""
        temp_dir = cls.get_temp_dir()
        cleaned_count = 0
        now = time.time()

        for item in temp_dir.glob("tmp_*"):
            if item.is_file():
                try:
                    age = now - item.stat().st_mtime
                    if age > max_age_seconds:
                        item.unlink()
                        cleaned_count += 1
                except OSError:
                    pass

        if cleaned_count > 0:
            AuditLogger.log_event(
                operation="cleanup_stale_temp_files",
                details=f"Cleaned up {cleaned_count} stale temporary file(s)",
            )

        return cleaned_count
