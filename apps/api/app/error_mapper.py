from __future__ import annotations

import uuid
from typing import Any, Dict
from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse


class ErrorCode:
    UNSUPPORTED_FORMAT = "DOC-001"
    INVALID_FILE = "DOC-002"
    CORRUPTED_PACKAGE = "DOC-003"
    PASSWORD_PROTECTED = "DOC-004"
    FILE_TOO_LARGE = "DOC-005"
    ACCESS_DENIED = "DOC-006"
    FILE_IN_USE = "DOC-007"
    INSUFFICIENT_DISK_SPACE = "DOC-008"
    SAVE_VALIDATION_FAILED = "DOC-009"
    UNEXPECTED_INTERNAL_ERROR = "DOC-010"


class DocuSyncError(Exception):
    """Base exception for all DocuSync document handling errors."""

    def __init__(
        self,
        code: str,
        title: str,
        message: str,
        action: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        reference_id: str | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.title = title
        self.message = message
        self.action = action
        self.status_code = status_code
        self.reference_id = reference_id or f"REF-{uuid.uuid4().hex[:8].upper()}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "title": self.title,
                "message": self.message,
                "action": self.action,
                "reference_id": self.reference_id,
            }
        }


class UnsupportedFormatError(DocuSyncError):
    def __init__(self, message: str = "This phase supports .docx files only.", action: str = "Choose another file."):
        super().__init__(
            code=ErrorCode.UNSUPPORTED_FORMAT,
            title="Unsupported Format",
            message=message,
            action=action,
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        )


class InvalidDocumentError(DocuSyncError):
    def __init__(
        self,
        message: str = "The selected file is not a valid Word document.",
        action: str = "Open and resave it in Microsoft Word.",
    ):
        super().__init__(
            code=ErrorCode.INVALID_FILE,
            title="Invalid or Renamed File",
            message=message,
            action=action,
            status_code=status.HTTP_400_BAD_REQUEST,
        )


class CorruptedPackageError(DocuSyncError):
    def __init__(
        self,
        message: str = "The document appears to be damaged or incomplete.",
        action: str = "Try another copy or Word repair.",
    ):
        super().__init__(
            code=ErrorCode.CORRUPTED_PACKAGE,
            title="Corrupted Package",
            message=message,
            action=action,
            status_code=status.HTTP_400_BAD_REQUEST,
        )


class PasswordProtectedError(DocuSyncError):
    def __init__(
        self,
        message: str = "Protected Word documents cannot be opened by DocuSync yet.",
        action: str = "Remove protection and import a copy.",
    ):
        super().__init__(
            code=ErrorCode.PASSWORD_PROTECTED,
            title="Password Protected Document",
            message=message,
            action=action,
            status_code=status.HTTP_400_BAD_REQUEST,
        )


class FileTooLargeError(DocuSyncError):
    def __init__(
        self,
        message: str = "The document is larger than the allowed limit.",
        action: str = "Use a smaller file or change an approved limit.",
    ):
        super().__init__(
            code=ErrorCode.FILE_TOO_LARGE,
            title="File Too Large",
            message=message,
            action=action,
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )


class AccessDeniedError(DocuSyncError):
    def __init__(
        self,
        message: str = "DocuSync cannot read or write this location.",
        action: str = "Choose a writable file or workspace.",
    ):
        super().__init__(
            code=ErrorCode.ACCESS_DENIED,
            title="Access Denied",
            message=message,
            action=action,
            status_code=status.HTTP_403_FORBIDDEN,
        )


class FileInUseError(DocuSyncError):
    def __init__(
        self,
        message: str = "The document is open or locked by another application.",
        action: str = "Close the other application and retry.",
    ):
        super().__init__(
            code=ErrorCode.FILE_IN_USE,
            title="File In Use",
            message=message,
            action=action,
            status_code=status.HTTP_409_CONFLICT,
        )


class InsufficientDiskSpaceError(DocuSyncError):
    def __init__(
        self,
        message: str = "There is not enough space to create a safe copy.",
        action: str = "Free disk space and retry.",
    ):
        super().__init__(
            code=ErrorCode.INSUFFICIENT_DISK_SPACE,
            title="Insufficient Disk Space",
            message=message,
            action=action,
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
        )


class SaveValidationFailedError(DocuSyncError):
    def __init__(
        self,
        message: str = "The new version could not be verified. Your previous version was restored.",
        action: str = "Retry or open the backup.",
    ):
        super().__init__(
            code=ErrorCode.SAVE_VALIDATION_FAILED,
            title="Save Validation Failed",
            message=message,
            action=action,
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


class UnexpectedInternalError(DocuSyncError):
    def __init__(
        self,
        message: str = "DocuSync could not complete the operation.",
        action: str = "Retry; provide the support reference from the log if it continues.",
    ):
        super().__init__(
            code=ErrorCode.UNEXPECTED_INTERNAL_ERROR,
            title="Unexpected Error",
            message=message,
            action=action,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


class ErrorMapper:
    """Maps technical exceptions to structured user-facing errors."""

    @staticmethod
    def map_exception(exc: Exception) -> DocuSyncError:
        if isinstance(exc, DocuSyncError):
            return exc
        if isinstance(exc, HTTPException):
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            detail_lower = detail.lower()
            if "unsupported" in detail_lower or "only docx" in detail_lower or "are supported" in detail_lower or ".docx files" in detail_lower:
                return UnsupportedFormatError(message=detail)
            if "too large" in detail_lower or "size" in detail_lower:
                return FileTooLargeError(message=detail)
            if "corrupt" in detail_lower or "parts are missing" in detail_lower:
                return CorruptedPackageError(message=detail)
            if "password" in detail_lower or "protected" in detail_lower or "encrypted" in detail_lower:
                return PasswordProtectedError(message=detail)
            if "permission" in detail_lower or "denied" in detail_lower:
                return AccessDeniedError(message=detail)
            return InvalidDocumentError(message=detail)
        if isinstance(exc, PermissionError):
            return AccessDeniedError(message="DocuSync cannot access the specified file or directory.")
        if isinstance(exc, FileNotFoundError):
            return InvalidDocumentError(message="The requested file was not found.")
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (32, 33):  # Windows file locked
            return FileInUseError()
        return UnexpectedInternalError()

    @staticmethod
    def create_response(exc: Exception) -> JSONResponse:
        error = ErrorMapper.map_exception(exc)
        return JSONResponse(status_code=error.status_code, content=error.to_dict())
