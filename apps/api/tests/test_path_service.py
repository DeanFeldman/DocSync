from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import pytest

from app.error_mapper import AccessDeniedError
from app.path_service import SafePathService


def test_normalise_standard_filename():
    assert SafePathService.normalise_filename("StandardReport.docx") == "StandardReport.docx"


def test_normalise_unsafe_characters():
    dirty = "Report: 2026/07<v1>*.docx"
    cleaned = SafePathService.normalise_filename(dirty)
    assert ":" not in cleaned
    assert "/" not in cleaned
    assert "<" not in cleaned
    assert ">" not in cleaned
    assert "*" not in cleaned
    assert cleaned.endswith(".docx")


def test_normalise_windows_reserved_names():
    assert SafePathService.normalise_filename("CON.docx") == "safe_CON.docx"
    assert SafePathService.normalise_filename("prn.docx") == "safe_prn.docx"
    assert SafePathService.normalise_filename("NUL.txt") == "safe_NUL.txt"
    assert SafePathService.normalise_filename("COM1.docx") == "safe_COM1.docx"


def test_path_containment_verification(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    valid_file = workspace / "document.docx"
    assert SafePathService.is_contained(valid_file, workspace)

    traversal_file = workspace / ".." / "outside.docx"
    assert not SafePathService.is_contained(traversal_file, workspace)

    with pytest.raises(AccessDeniedError) as exc_info:
        SafePathService.ensure_contained(traversal_file, workspace)
    assert exc_info.value.code == "DOC-006"
