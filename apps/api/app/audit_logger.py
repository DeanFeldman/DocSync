from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

APP_VERSION = "1.17.0"

class AuditLogger:
    """Structured audit logger recording non-sensitive operational diagnostics."""

    _logger: logging.Logger | None = None
    _file_handler: logging.FileHandler | None = None

    @classmethod
    def get_logger(cls) -> logging.Logger:
        if cls._logger is None:
            logger = logging.getLogger("DocuSync.AuditLogger")
            logger.setLevel(logging.INFO)

            log_dir = settings.data_dir / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_file = log_dir / "audit.log"

            handler = logging.FileHandler(log_file, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)

            cls._logger = logger
            cls._file_handler = handler
        return cls._logger

    @classmethod
    def sanitize_detail(cls, detail: Any) -> str:
        """Ensure detail string contains no sensitive data or arbitrary body text."""
        if not detail:
            return ""
        text = str(detail)
        # Limit length to prevent dumping arbitrary text into logs
        if len(text) > 300:
            text = text[:300] + "... [TRUNCATED]"
        return text

    @classmethod
    def log_event(
        cls,
        operation: str,
        file_id: str | None = None,
        error_code: str | None = None,
        reference_id: str | None = None,
        details: Any = None,
    ) -> dict[str, Any]:
        """Record a structured audit log event excluding document body text."""
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "app_version": APP_VERSION,
            "operation": operation,
            "file_id": file_id or "N/A",
            "error_code": error_code,
            "reference_id": reference_id,
            "details": cls.sanitize_detail(details),
        }

        log_json = json.dumps(record, ensure_ascii=False)
        cls.get_logger().info(log_json)
        return record
