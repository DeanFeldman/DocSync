from __future__ import annotations

import os
import re
from pathlib import Path

from .error_mapper import AccessDeniedError

# Windows reserved filenames (stem or full filename)
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}

UNSAFE_CHARS_PATTERN = re.compile(r'[<>:"/\\|?*\x00-\x1F]')
MULTIPLE_DOTS_PATTERN = re.compile(r"\.{2,}")


class SafePathService:
    """Provides file name normalisation and path traversal prevention."""

    @staticmethod
    def normalise_filename(filename: str, max_length: int = 255) -> str:
        """Normalise file name, remove unsafe characters, prevent reserved names and traversal."""
        if not filename or not isinstance(filename, str):
            return "document.docx"

        # Extract only the base filename to prevent path traversal attempts inside filenames
        name = Path(filename).name.strip()

        # Remove control and unsafe Windows path characters
        cleaned = UNSAFE_CHARS_PATTERN.sub("_", name)

        # Replace sequences of dots or relative path markers
        cleaned = MULTIPLE_DOTS_PATTERN.sub(".", cleaned).strip(" .")

        if not cleaned:
            return "document.docx"

        # Split stem and extension
        stem = Path(cleaned).stem
        ext = Path(cleaned).suffix

        # Check Windows reserved name (case-insensitive check on stem)
        if stem.upper() in WINDOWS_RESERVED_NAMES:
            stem = f"safe_{stem}"

        # Combine stem and extension
        safe_name = f"{stem}{ext}" if ext else stem

        # Truncate if exceeds max length while preserving extension
        if len(safe_name) > max_length:
            if ext and len(ext) < max_length:
                max_stem_len = max_length - len(ext)
                safe_name = f"{stem[:max_stem_len]}{ext}"
            else:
                safe_name = safe_name[:max_length]

        return safe_name or "document.docx"

    @staticmethod
    def is_contained(target_path: Path, base_dir: Path) -> bool:
        """Check if target_path resolves inside base_dir."""
        try:
            resolved_target = target_path.resolve()
            resolved_base = base_dir.resolve()
            return resolved_target == resolved_base or resolved_base in resolved_target.parents
        except (ValueError, RuntimeError, OSError):
            return False

    @staticmethod
    def ensure_contained(target_path: Path, base_dir: Path) -> Path:
        """Verify containment and return canonical target_path or raise AccessDeniedError."""
        if not SafePathService.is_contained(target_path, base_dir):
            raise AccessDeniedError(
                message=f"Path traversal detected: target is outside the approved location.",
                action="Ensure operations stay within the application workspace.",
            )
        return target_path.resolve()
