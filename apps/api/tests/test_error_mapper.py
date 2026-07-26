from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from fastapi import HTTPException

from app.error_mapper import (
    DocuSyncError,
    ErrorCode,
    ErrorMapper,
    InvalidDocumentError,
    UnsupportedFormatError,
)


def test_custom_exception_mapping():
    err = UnsupportedFormatError("PDF files are not supported.")
    mapped = ErrorMapper.map_exception(err)
    assert mapped.code == ErrorCode.UNSUPPORTED_FORMAT
    assert mapped.status_code == 415

    res = ErrorMapper.create_response(err)
    assert res.status_code == 415


def test_http_exception_mapping():
    http_exc = HTTPException(status_code=415, detail="file.txt: only DOCX files are supported.")
    mapped = ErrorMapper.map_exception(http_exc)
    assert mapped.code == ErrorCode.UNSUPPORTED_FORMAT


def test_permission_error_mapping():
    perm_err = PermissionError("Permission denied writing to /root")
    mapped = ErrorMapper.map_exception(perm_err)
    assert mapped.code == ErrorCode.ACCESS_DENIED
    assert mapped.status_code == 403
