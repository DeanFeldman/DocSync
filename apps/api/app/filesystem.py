"""Filesystem paths that work without the Windows long-path policy."""

import os
from pathlib import Path


def disk_path(path: Path) -> Path:
    absolute = path.absolute()
    if os.name != "nt":
        return absolute
    value = os.path.normpath(absolute)
    if value.startswith("\\\\?\\"):
        return Path(value)
    return Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)
