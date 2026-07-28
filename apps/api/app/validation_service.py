from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path
from typing import Union

from docx import Document
from docx.document import Document as DocxDocument

from .config import settings
from .error_mapper import (
    CorruptedPackageError,
    FileTooLargeError,
    InvalidDocumentError,
    PasswordProtectedError,
    UnsupportedFormatError,
)

ZIP_MAGIC_HEADER = b"PK\x03\x04"
MAX_ZIP_ENTRIES = 1_000
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024  # 100 MB


class DocumentValidationService:
    """Performs extension, signature, size, Open XML, encryption and output validation."""

    @staticmethod
    def validate_package(
        source: Union[Path, bytes],
        filename: str = "document.docx",
        max_bytes: int | None = None,
    ) -> bytes:
        """Validate the DOCX package without constructing its object model.

        The returned bytes are safe to pass to ``parse_file`` exactly once.
        """
        # VR-01 Extension Check
        if not filename.lower().endswith(".docx"):
            raise UnsupportedFormatError(
                message=f"'{filename}' is not a .docx file. Only Microsoft Word Open XML documents (.docx) are supported in this phase.",
                action="Please select a supported .docx file.",
            )

        # Retrieve payload bytes
        if isinstance(source, Path):
            if not source.exists():
                raise InvalidDocumentError(message=f"File not found: {source.name}")
            payload = source.read_bytes()
        else:
            payload = source

        file_size = len(payload)

        # VR-02 Empty File Check
        if file_size == 0:
            raise InvalidDocumentError(
                message=f"'{filename}' is empty (0 bytes).",
                action="Select a non-empty Word document.",
            )

        # VR-03 Maximum Size Check
        limit = max_bytes if max_bytes is not None else settings.max_file_bytes
        if file_size > limit:
            limit_mb = round(limit / (1024 * 1024), 1)
            raise FileTooLargeError(
                message=f"'{filename}' exceeds the maximum allowed file size of {limit_mb} MB.",
                action=f"Reduce file size below {limit_mb} MB or configure a higher limit.",
            )

        # VR-04 Package Signature Check (ZIP Magic Header & zipfile structure)
        if not payload.startswith(ZIP_MAGIC_HEADER) or not zipfile.is_zipfile(BytesIO(payload)):
            raise InvalidDocumentError(
                message=f"'{filename}' is not a valid ZIP-based Word document package.",
                action="Confirm the file has not been renamed or corrupted.",
            )

        # VR-05, VR-06, VR-07 Open XML Structure, Encryption & Decompression Checks
        try:
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                entries = archive.infolist()
                names = {entry.filename for entry in entries}

                # SEC-07 Decompression Limits
                if len(entries) > MAX_ZIP_ENTRIES:
                    raise CorruptedPackageError(
                        message=f"'{filename}' contains too many parts ({len(entries)}), exceeding safety limits.",
                        action="Resave the file in Microsoft Word.",
                    )

                total_uncompressed = sum(entry.file_size for entry in entries)
                if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                    raise FileTooLargeError(
                        message=f"'{filename}' expanded content size exceeds maximum safety limit.",
                        action="Resave the document to optimize its package size.",
                    )

                # VR-07 Encrypted / Password Protection Checks
                # 1) Standard Zip Encryption flag
                if any(entry.flag_bits & 0x1 for entry in entries):
                    raise PasswordProtectedError(
                        message=f"'{filename}' is password-protected or encrypted.",
                        action="Open the file in Microsoft Word, remove password protection, and import an unprotected copy.",
                    )

                # 2) OLE Encrypted Package streams in ZIP (e.g. EncryptedPackage, EncryptionInfo)
                if "EncryptedPackage" in names or "EncryptionInfo" in names or "encryptedPackage" in names:
                    raise PasswordProtectedError(
                        message=f"'{filename}' contains an encrypted Word payload.",
                        action="Open the file in Microsoft Word, remove password protection, and import an unprotected copy.",
                    )

                # VR-05 Required Content Types and Relationships
                if "[Content_Types].xml" not in names:
                    raise CorruptedPackageError(
                        message=f"'{filename}' is missing required '[Content_Types].xml' component.",
                        action="Resave the file in Microsoft Word.",
                    )

                # Check if [Content_Types].xml specifies encrypted package
                try:
                    content_types_data = archive.read("[Content_Types].xml")
                    if b"encrypted" in content_types_data.lower() and b"package" in content_types_data.lower():
                        raise PasswordProtectedError(
                            message=f"'{filename}' is an encrypted Open XML package.",
                            action="Remove protection in Microsoft Word before importing.",
                        )
                    # SEC-06 XML External Entity (XXE) Prevention check
                    if b"<!DOCTYPE" in content_types_data or b"<!ENTITY" in content_types_data:
                        raise CorruptedPackageError(
                            message=f"'{filename}' contains invalid or unsafe XML declarations.",
                            action="Resave the file in Microsoft Word.",
                        )
                except (KeyError, RuntimeError):
                    raise CorruptedPackageError(
                        message=f"'{filename}' has unreadable '[Content_Types].xml' component.",
                        action="Try another copy or Word repair.",
                    )

                # VR-06 Main Document Part Check
                if "word/document.xml" not in names:
                    raise CorruptedPackageError(
                        message=f"'{filename}' is missing the main Word document part ('word/document.xml').",
                        action="Confirm the file is a valid Word document.",
                    )

                # SEC-06 Check word/document.xml for XXE
                try:
                    doc_xml_data = archive.read("word/document.xml")
                    if b"<!DOCTYPE" in doc_xml_data or b"<!ENTITY" in doc_xml_data:
                        raise CorruptedPackageError(
                            message=f"'{filename}' contains invalid or unsafe XML declarations.",
                            action="Resave the file in Microsoft Word.",
                        )
                except (KeyError, RuntimeError):
                    raise CorruptedPackageError(
                        message=f"'{filename}' has unreadable 'word/document.xml' component.",
                        action="Try another copy or Word repair.",
                    )

        except zipfile.BadZipFile as exc:
            raise CorruptedPackageError(
                message=f"'{filename}' is a corrupted ZIP package.",
                action="Try another copy or resave in Microsoft Word.",
            ) from exc

        return payload

    @staticmethod
    def parse_file(
        payload: bytes,
        filename: str = "document.docx",
    ) -> DocxDocument:
        """Construct and return the validated python-docx representation."""
        try:
            return Document(BytesIO(payload))
        except Exception as exc:
            exc_str = str(exc).lower()
            if "encrypted" in exc_str or "password" in exc_str or "protected" in exc_str:
                raise PasswordProtectedError(
                    message=f"'{filename}' is password-protected or encrypted.",
                    action="Open the file in Microsoft Word, remove password protection, and import an unprotected copy.",
                ) from exc
            raise CorruptedPackageError(
                message=f"'{filename}' could not be parsed as a Word document. It may be corrupted or malformed.",
                action="Open and resave the file in Microsoft Word.",
            ) from exc

    @staticmethod
    def validate_and_parse_file(
        source: Union[Path, bytes],
        filename: str = "document.docx",
        max_bytes: int | None = None,
    ) -> tuple[bytes, DocxDocument]:
        """Validate a DOCX and return both bytes and its single parsed instance."""
        payload = DocumentValidationService.validate_package(
            source,
            filename=filename,
            max_bytes=max_bytes,
        )
        return payload, DocumentValidationService.parse_file(
            payload,
            filename=filename,
        )

    @staticmethod
    def validate_file(
        source: Union[Path, bytes],
        filename: str = "document.docx",
        max_bytes: int | None = None,
    ) -> bytes:
        """Validate a DOCX according to rules VR-01 to VR-07."""
        payload, _document = DocumentValidationService.validate_and_parse_file(
            source,
            filename=filename,
            max_bytes=max_bytes,
        )
        return payload
