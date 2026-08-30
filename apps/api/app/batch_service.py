from __future__ import annotations

from collections import defaultdict
from io import BytesIO
import hashlib
import json
from pathlib import Path
import shutil
from time import perf_counter
import zipfile

from docx import Document
from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from .config import settings
from .editor_service import (
    EDITOR_GENERATION_EXECUTOR,
    EDITOR_GENERATION_LOCK,
    EDITOR_QUEUE_LOCK,
    _apply_document_targets,
    _commit_editor_generation_stage,
    _location_key,
    _queue_previews_safely,
    _replace_current_elements_and_create_revisions,
    _serialize_generated_document_updates,
    _validate_editor_request,
    current_version_for_document,
    document_version_path,
    new_id,
    serialize_editor_generation_status,
    utc_isoformat,
    utc_now,
)
from .find_replace_service import bind_inventory_to_revisions
from .models import (
    DocumentHead,
    DocumentRecord,
    DocumentSet,
    DocumentVersion,
    EditBatchOccurrence,
    EditBatchOperation,
    EditorOperation,
    EditorOperationTarget,
)
from .schemas import EditBatchCreate, EditBatchOperationRequest, EditorEditRequest
from .text_inventory_service import (
    DocumentTextInventory,
    TextReplacementPatch,
    apply_text_replacements,
    build_text_inventory,
    find_occurrence_ranges,
    occurrence_id,
)


def _batch_query():
    return (
        select(EditorOperation)
        .options(
            selectinload(EditorOperation.batch_operations).selectinload(
                EditBatchOperation.occurrences
            ),
            selectinload(EditorOperation.versions),
        )
        .execution_options(populate_existing=True)
    )


def get_edit_batch(session: Session, batch_id: str) -> EditorOperation:
    batch = session.scalar(_batch_query().where(EditorOperation.id == batch_id))
    if batch is None or batch.operation_type != "batch":
        raise HTTPException(status_code=404, detail="Edit batch not found.")
    return batch


def _require_draft(batch: EditorOperation) -> None:
    if batch.status != "draft":
        raise HTTPException(
            status_code=409,
            detail="Only a draft batch can be changed.",
        )


def _batch_title(batch: EditorOperation) -> str:
    envelope = batch.preview_json or {}
    return str(envelope.get("title") or "Pending changes")


def _base_versions(batch: EditorOperation) -> dict[str, str]:
    envelope = batch.preview_json or {}
    value = envelope.get("base_versions", {}) if isinstance(envelope, dict) else {}
    return {str(key): str(item) for key, item in value.items()}


def _operation_request(operation: EditBatchOperation) -> EditBatchOperationRequest:
    return EditBatchOperationRequest.model_validate(operation.request_json)


def _batch_state_signature(batch: EditorOperation) -> str:
    """Fingerprint the durable draft state that a preview has checked."""
    state = [
        {
            "id": operation.id,
            "enabled": operation.enabled,
            "request": operation.request_json,
            "occurrences": [
                {"id": item.id, "selected": item.selected}
                for item in operation.occurrences
            ],
        }
        for operation in sorted(batch.batch_operations, key=lambda item: item.operation_index)
    ]
    return hashlib.sha256(
        json.dumps(state, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def serialize_edit_batch(session: Session, batch: EditorOperation) -> dict:
    document_ids = {
        occurrence.document_id
        for operation in batch.batch_operations
        if operation.enabled
        for occurrence in operation.occurrences
        if occurrence.selected
    }
    for operation in batch.batch_operations:
        if not operation.enabled or operation.operation_type != "editor_replace":
            continue
        request = _operation_request(operation)
        if request.editor_request is not None:
            document_ids.update(request.editor_request.base_versions)
    names = {
        document_id: name
        for document_id, name in session.execute(
            select(DocumentRecord.id, DocumentRecord.original_name).where(
                DocumentRecord.id.in_(document_ids)
            )
        ).all()
    } if document_ids else {}
    operations = []
    for operation in sorted(
        batch.batch_operations,
        key=lambda item: (item.operation_index, item.created_at),
    ):
        request = _operation_request(operation)
        occurrence_items = [
            {
                "id": item.id,
                "occurrence_id": item.occurrence_id,
                "document_id": item.document_id,
                "document_name": names.get(item.document_id, "Document"),
                "base_version_id": item.base_version_id,
                "version_id": item.base_version_id,
                "result_version_id": item.result_version_id,
                "segment_id": item.segment_id,
                "element_id": item.element_id,
                "part_path": item.part_path,
                "structure_type": item.structure_type,
                "match_start": item.match_start,
                "match_end": item.match_end,
                "matched_text": item.matched_text,
                "location": item.location_json or {},
                "segment_text": (item.location_json or {}).get("segment_text"),
                "selected": item.selected,
                "editable": item.editable,
                "read_only_reason": item.read_only_reason,
            }
            for item in operation.occurrences
        ]
        editor_request = request.editor_request
        operations.append(
            {
                "id": operation.id,
                "operation_index": operation.operation_index,
                "operation_type": operation.operation_type,
                "label": operation.label,
                "replacement_text": operation.replacement_text,
                "enabled": operation.enabled,
                "find_request": (
                    request.find_request.model_dump(mode="json")
                    if request.find_request is not None
                    else None
                ),
                "editor_request": (
                    editor_request.model_dump(mode="json")
                    if editor_request is not None
                    else None
                ),
                "occurrences": occurrence_items,
                "occurrence_count": len(occurrence_items),
                "document_count": len(
                    {item["document_id"] for item in occurrence_items}
                    | (set(editor_request.base_versions) if editor_request else set())
                ),
                "created_at": utc_isoformat(operation.created_at),
                "updated_at": utc_isoformat(operation.updated_at),
            }
        )
    envelope = batch.preview_json or {}
    return {
        "id": batch.id,
        "batch_id": batch.id,
        "document_set_id": batch.document_set_id,
        "title": _batch_title(batch),
        "status": batch.status,
        "stage": batch.stage,
        "base_versions": _base_versions(batch),
        "operations": operations,
        "operation_count": len(operations),
        "enabled_operation_count": sum(item["enabled"] for item in operations),
        "affected_document_ids": sorted(document_ids),
        "affected_document_count": len(document_ids),
        "preview": envelope.get("preview") if isinstance(envelope, dict) else None,
        "error_detail": batch.error_detail,
        "created_at": utc_isoformat(batch.created_at),
        "updated_at": utc_isoformat(batch.updated_at),
        "completed_at": (
            utc_isoformat(batch.completed_at) if batch.completed_at is not None else None
        ),
        "generation_status_url": f"/api/editor-operations/{batch.id}",
    }


def get_draft_edit_batch(session: Session, document_set_id: str) -> dict:
    if session.get(DocumentSet, document_set_id) is None:
        raise HTTPException(status_code=404, detail="Document set not found.")
    batch = session.scalar(
        _batch_query()
        .where(
            EditorOperation.document_set_id == document_set_id,
            EditorOperation.operation_type == "batch",
            EditorOperation.status == "draft",
        )
        .order_by(EditorOperation.created_at.desc())
    )
    return {"batch": serialize_edit_batch(session, batch) if batch else None}


def create_edit_batch(
    session: Session,
    document_set_id: str,
    request: EditBatchCreate,
) -> dict:
    if session.get(DocumentSet, document_set_id) is None:
        raise HTTPException(status_code=404, detail="Document set not found.")
    existing = session.scalar(
        _batch_query()
        .where(
            EditorOperation.document_set_id == document_set_id,
            EditorOperation.operation_type == "batch",
            EditorOperation.status == "draft",
        )
        .order_by(EditorOperation.created_at.desc())
    )
    if existing is not None:
        return serialize_edit_batch(session, existing)
    batch = EditorOperation(
        id=new_id(),
        document_set_id=document_set_id,
        operation_type="batch",
        status="draft",
        stage="draft",
        preview_json={"title": request.title, "base_versions": {}},
    )
    session.add(batch)
    session.commit()
    return serialize_edit_batch(session, get_edit_batch(session, batch.id))


def _validate_find_occurrences(
    session: Session,
    document_set_id: str,
    request: EditBatchOperationRequest,
) -> list[dict]:
    assert request.find_request is not None
    inventories: dict[tuple[str, str], DocumentTextInventory] = {}
    results: list[dict] = []
    for selected in request.occurrences:
        document = session.get(DocumentRecord, selected.document_id)
        version = session.get(DocumentVersion, selected.version_id)
        head = session.get(DocumentHead, selected.document_id)
        if (
            document is None
            or document.document_set_id != document_set_id
            or version is None
            or version.document_id != document.id
        ):
            raise HTTPException(
                status_code=422,
                detail="Every selected occurrence must belong to this document set.",
            )
        if head is None or head.current_version_id != version.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{document.original_name} changed after this search. "
                    "Run Find again before adding the operation."
                ),
            )
        key = (document.id, version.id)
        inventory = inventories.get(key)
        if inventory is None:
            inventory = build_text_inventory(
                document_version_path(version),
                document_id=document.id,
                version_id=version.id,
            )
            bind_inventory_to_revisions(session, inventory)
            inventories[key] = inventory
        segment = inventory.by_id.get(selected.segment_id)
        if segment is None or segment.part_path != selected.part_path:
            raise HTTPException(
                status_code=409,
                detail="A selected occurrence no longer maps to its OOXML text segment.",
            )
        expected_occurrence_id = occurrence_id(
            segment,
            selected.match_start,
            selected.match_end,
        )
        valid_ranges = find_occurrence_ranges(
            segment.text,
            request.find_request.query,
            match_case=request.find_request.match_case,
            whole_word=request.find_request.whole_word,
        )
        if (
            selected.occurrence_id != expected_occurrence_id
            or (selected.match_start, selected.match_end) not in valid_ranges
            or segment.text[selected.match_start : selected.match_end]
            != selected.matched_text
        ):
            raise HTTPException(
                status_code=409,
                detail="A selected occurrence does not match the immutable search result.",
            )
        editable, reason = segment.editability_for_range(
            selected.match_start,
            selected.match_end,
        )
        if not editable:
            raise HTTPException(
                status_code=422,
                detail=reason or "The selected occurrence is read-only.",
            )
        results.append(
            {
                "selected": selected,
                "document": document,
                "version": version,
                "segment": segment,
            }
        )
    return results


def _validate_batch_operation(
    session: Session,
    batch: EditorOperation,
    request: EditBatchOperationRequest,
) -> tuple[list[dict], dict[str, str]]:
    if request.operation_type == "find_replace":
        validated = _validate_find_occurrences(
            session,
            batch.document_set_id,
            request,
        )
        bases = {
            item["document"].id: item["version"].id for item in validated
        }
        return validated, bases
    assert request.editor_request is not None
    _source, _document, _context, validated_targets = _validate_editor_request(
        session,
        batch.document_set_id,
        request.editor_request,
    )
    return [], {
        document_id: version_id
        for document_id, version_id in request.editor_request.base_versions.items()
        if any(item[2].id == document_id for item in validated_targets)
    }


def _merge_base_versions(batch: EditorOperation, bases: dict[str, str]) -> None:
    existing = _base_versions(batch)
    for document_id, version_id in bases.items():
        previous = existing.get(document_id)
        if previous is not None and previous != version_id:
            raise HTTPException(
                status_code=409,
                detail=(
                    "A document in this pending batch was based on a different "
                    "version. Clear or apply the batch before adding this change."
                ),
            )
        existing[document_id] = version_id
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {**envelope, "base_versions": existing, "preview": None}


def _rebuild_batch_base_versions(session: Session, batch: EditorOperation) -> None:
    bases: dict[str, str] = {}
    operations = list(
        session.scalars(
            select(EditBatchOperation).where(
                EditBatchOperation.batch_id == batch.id
            )
        )
    )
    for operation in operations:
        if operation.operation_type == "find_replace":
            occurrences = session.scalars(
                select(EditBatchOccurrence).where(
                    EditBatchOccurrence.batch_operation_id == operation.id
                )
            )
            for occurrence in occurrences:
                bases[occurrence.document_id] = occurrence.base_version_id
        else:
            request = _operation_request(operation)
            if request.editor_request is not None:
                bases.update(request.editor_request.base_versions)
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {**envelope, "base_versions": bases, "preview": None}


def add_edit_batch_operation(
    session: Session,
    batch_id: str,
    request: EditBatchOperationRequest,
) -> dict:
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    validated, bases = _validate_batch_operation(session, batch, request)
    _merge_base_versions(batch, bases)
    highest_index = session.scalar(
        select(func.max(EditBatchOperation.operation_index)).where(
            EditBatchOperation.batch_id == batch.id
        )
    )
    next_index = int(highest_index if highest_index is not None else -1) + 1
    operation = EditBatchOperation(
        id=new_id(),
        batch_id=batch.id,
        operation_index=next_index,
        operation_type=request.operation_type,
        label=request.label,
        replacement_text=request.replacement_text,
        request_json=request.model_dump(mode="json"),
        enabled=request.enabled,
    )
    session.add(operation)
    session.flush()
    for item in validated:
        selected = item["selected"]
        segment = item["segment"]
        session.add(
            EditBatchOccurrence(
                id=new_id(),
                batch_operation_id=operation.id,
                occurrence_id=selected.occurrence_id,
                document_id=selected.document_id,
                base_version_id=selected.version_id,
                segment_id=selected.segment_id,
                element_id=segment.element_id,
                part_path=selected.part_path,
                structure_type=segment.effective_structure_type(
                    selected.match_start,
                    selected.match_end,
                ),
                match_start=selected.match_start,
                match_end=selected.match_end,
                matched_text=selected.matched_text,
                # Keep the immutable segment text with the durable occurrence so
                # Layout can render a working overlay without reopening the DOCX.
                location_json={**selected.location, "segment_text": segment.text},
                selected=True,
                editable=True,
            )
        )
    session.flush()
    _rebuild_batch_base_versions(session, batch)
    session.commit()
    return serialize_edit_batch(session, get_edit_batch(session, batch.id))


def update_edit_batch_operation(
    session: Session,
    batch_id: str,
    operation_id: str,
    request: EditBatchOperationRequest,
) -> dict:
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    operation = session.get(EditBatchOperation, operation_id)
    if operation is None or operation.batch_id != batch.id:
        raise HTTPException(status_code=404, detail="Batch operation not found.")
    validated, bases = _validate_batch_operation(session, batch, request)
    _merge_base_versions(batch, bases)
    operation.operation_type = request.operation_type
    operation.label = request.label
    operation.replacement_text = request.replacement_text
    operation.request_json = request.model_dump(mode="json")
    operation.enabled = request.enabled
    session.execute(
        delete(EditBatchOccurrence).where(
            EditBatchOccurrence.batch_operation_id == operation.id
        )
    )
    session.flush()
    for item in validated:
        selected = item["selected"]
        segment = item["segment"]
        session.add(
            EditBatchOccurrence(
                id=new_id(),
                batch_operation_id=operation.id,
                occurrence_id=selected.occurrence_id,
                document_id=selected.document_id,
                base_version_id=selected.version_id,
                segment_id=selected.segment_id,
                element_id=segment.element_id,
                part_path=selected.part_path,
                structure_type=segment.effective_structure_type(
                    selected.match_start,
                    selected.match_end,
                ),
                match_start=selected.match_start,
                match_end=selected.match_end,
                matched_text=selected.matched_text,
                location_json={**selected.location, "segment_text": segment.text},
                selected=True,
                editable=True,
            )
        )
    session.flush()
    _rebuild_batch_base_versions(session, batch)
    session.commit()
    return serialize_edit_batch(session, get_edit_batch(session, batch.id))


def remove_edit_batch_operation(
    session: Session,
    batch_id: str,
    operation_id: str,
) -> dict:
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    operation = session.get(EditBatchOperation, operation_id)
    if operation is None or operation.batch_id != batch.id:
        raise HTTPException(status_code=404, detail="Batch operation not found.")
    session.delete(operation)
    session.flush()
    _rebuild_batch_base_versions(session, batch)
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {**envelope, "preview": None}
    session.commit()
    return serialize_edit_batch(session, get_edit_batch(session, batch.id))


def set_edit_batch_occurrence_selection(
    session: Session,
    batch_id: str,
    occurrence_row_id: str,
    *,
    selected: bool,
) -> dict:
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    occurrence = session.get(EditBatchOccurrence, occurrence_row_id)
    if (
        occurrence is None
        or occurrence.batch_operation.batch_id != batch.id
    ):
        raise HTTPException(status_code=404, detail="Batch occurrence not found.")
    if selected and not occurrence.editable:
        raise HTTPException(
            status_code=422,
            detail=occurrence.read_only_reason or "This occurrence is read-only.",
        )
    occurrence.selected = selected
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {**envelope, "preview": None}
    session.commit()
    return serialize_edit_batch(session, get_edit_batch(session, batch.id))


def clear_edit_batch(session: Session, batch_id: str) -> None:
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    session.delete(batch)
    session.commit()


def _conflict(code: str, message: str, **context) -> dict:
    return {"code": code, "message": message, **context}


def _compile_edit_batch(session: Session, batch: EditorOperation) -> dict:
    enabled = [item for item in batch.batch_operations if item.enabled]
    conflicts: list[dict] = []
    by_document: dict[str, dict] = {}
    find_ranges: dict[tuple[str, str], list[tuple[int, int, str]]] = defaultdict(list)
    editor_elements: dict[tuple[str, str], str] = {}
    occurrence_ids: dict[tuple[str, str], str] = {}

    if not enabled:
        conflicts.append(_conflict("empty_batch", "Enable at least one pending operation."))

    for document_id, expected_version_id in _base_versions(batch).items():
        document = session.get(DocumentRecord, document_id)
        head = session.get(DocumentHead, document_id)
        version = session.get(DocumentVersion, expected_version_id)
        if (
            document is None
            or document.document_set_id != batch.document_set_id
            or version is None
            or version.document_id != document_id
        ):
            conflicts.append(
                _conflict(
                    "invalid_base_version",
                    "A pending document version no longer exists in this workspace.",
                    document_id=document_id,
                )
            )
            continue
        if head is None or head.current_version_id != expected_version_id:
            conflicts.append(
                _conflict(
                    "stale_base_version",
                    f"{document.original_name} changed after this batch was assembled.",
                    document_id=document_id,
                    expected_version_id=expected_version_id,
                    current_version_id=head.current_version_id if head else None,
                )
            )
            continue
        by_document[document_id] = {
            "document": document,
            "head": head,
            "base_version": version,
            "find_patches": [],
            "find_occurrences": [],
            "editor_targets": [],
            "editor_requests": [],
        }

    inventories: dict[str, DocumentTextInventory] = {}
    for operation in sorted(enabled, key=lambda item: item.operation_index):
        request = _operation_request(operation)
        if operation.operation_type == "editor_replace":
            assert request.editor_request is not None
            try:
                _source, _document, _context, targets = _validate_editor_request(
                    session,
                    batch.document_set_id,
                    request.editor_request,
                )
            except HTTPException as exc:
                conflicts.append(
                    _conflict(
                        "invalid_editor_operation",
                        str(exc.detail),
                        operation_id=operation.id,
                    )
                )
                continue
            for target, revision, document, delta in targets:
                key = (document.id, revision.element_id)
                previous = editor_elements.get(key)
                if previous is not None:
                    conflicts.append(
                        _conflict(
                            "duplicate_editor_target",
                            f"{document.original_name} has the same editor block in two operations.",
                            operation_id=operation.id,
                            conflicting_operation_id=previous,
                            document_id=document.id,
                            element_id=revision.element_id,
                        )
                    )
                editor_elements[key] = operation.id
                item = by_document.get(document.id)
                if item is not None:
                    item["editor_targets"].append((target, revision, document, delta, operation))
                    item["editor_requests"].append(request.editor_request)
            continue

        for occurrence in operation.occurrences:
            if not occurrence.selected:
                continue
            item = by_document.get(occurrence.document_id)
            if item is None:
                continue
            duplicate_key = (occurrence.document_id, occurrence.occurrence_id)
            previous = occurrence_ids.get(duplicate_key)
            if previous is not None:
                conflicts.append(
                    _conflict(
                        "duplicate_occurrence",
                        "The same occurrence is selected in more than one operation.",
                        operation_id=operation.id,
                        conflicting_operation_id=previous,
                        occurrence_id=occurrence.occurrence_id,
                    )
                )
            occurrence_ids[duplicate_key] = operation.id
            inventory = inventories.get(occurrence.document_id)
            if inventory is None:
                inventory = build_text_inventory(
                    document_version_path(item["base_version"]),
                    document_id=occurrence.document_id,
                    version_id=occurrence.base_version_id,
                )
                bind_inventory_to_revisions(session, inventory)
                inventories[occurrence.document_id] = inventory
            segment = inventory.by_id.get(occurrence.segment_id)
            if (
                segment is None
                or segment.part_path != occurrence.part_path
                or segment.text[occurrence.match_start : occurrence.match_end]
                != occurrence.matched_text
                or occurrence_id(
                    segment,
                    occurrence.match_start,
                    occurrence.match_end,
                )
                != occurrence.occurrence_id
            ):
                conflicts.append(
                    _conflict(
                        "stale_occurrence",
                        "A selected occurrence no longer matches its immutable version.",
                        operation_id=operation.id,
                        occurrence_id=occurrence.occurrence_id,
                    )
                )
                continue
            editable, reason = segment.editability_for_range(
                occurrence.match_start,
                occurrence.match_end,
            )
            if not editable:
                conflicts.append(
                    _conflict(
                        "read_only_occurrence",
                        reason or "A selected occurrence is read-only.",
                        operation_id=operation.id,
                        occurrence_id=occurrence.occurrence_id,
                    )
                )
                continue
            for start, end, previous_operation in find_ranges[
                (occurrence.document_id, occurrence.segment_id)
            ]:
                if occurrence.match_start < end and occurrence.match_end > start:
                    conflicts.append(
                        _conflict(
                            "overlapping_occurrences",
                            "Two pending find-and-replace ranges overlap.",
                            operation_id=operation.id,
                            conflicting_operation_id=previous_operation,
                            occurrence_id=occurrence.occurrence_id,
                        )
                    )
            find_ranges[(occurrence.document_id, occurrence.segment_id)].append(
                (occurrence.match_start, occurrence.match_end, operation.id)
            )
            if segment.element_id and (occurrence.document_id, segment.element_id) in editor_elements:
                conflicts.append(
                    _conflict(
                        "editor_find_collision",
                        "An editor replacement and find-and-replace target the same block.",
                        operation_id=operation.id,
                        conflicting_operation_id=editor_elements[
                            (occurrence.document_id, segment.element_id)
                        ],
                        document_id=occurrence.document_id,
                        element_id=segment.element_id,
                    )
                )
            patch = TextReplacementPatch(
                occurrence_id=occurrence.occurrence_id,
                segment_id=occurrence.segment_id,
                part_path=occurrence.part_path,
                match_start=occurrence.match_start,
                match_end=occurrence.match_end,
                expected_text=occurrence.matched_text,
                replacement_text=operation.replacement_text or "",
            )
            item["find_patches"].append(patch)
            item["find_occurrences"].append((occurrence, operation))

    # Editor operations may appear after a find operation in batch order. Do a
    # final order-independent collision pass so conflicts never depend on UI order.
    for (document_id, segment_id), ranges in find_ranges.items():
        inventory = inventories.get(document_id)
        segment = inventory.by_id.get(segment_id) if inventory else None
        if segment and segment.element_id:
            editor_operation = editor_elements.get((document_id, segment.element_id))
            if editor_operation:
                for _start, _end, find_operation in ranges:
                    if not any(
                        conflict.get("code") == "editor_find_collision"
                        and conflict.get("operation_id") == find_operation
                        and conflict.get("conflicting_operation_id") == editor_operation
                        for conflict in conflicts
                    ):
                        conflicts.append(
                            _conflict(
                                "editor_find_collision",
                                "An editor replacement and find-and-replace target the same block.",
                                operation_id=find_operation,
                                conflicting_operation_id=editor_operation,
                                document_id=document_id,
                                element_id=segment.element_id,
                            )
                        )

    for document_id in list(by_document):
        item = by_document[document_id]
        if not item["find_patches"] and not item["editor_targets"]:
            del by_document[document_id]
    if enabled and not by_document:
        conflicts.append(
            _conflict(
                "no_selected_targets",
                "Enable at least one operation with one selected target.",
            )
        )
    return {
        "batch": batch,
        "documents": by_document,
        "inventories": inventories,
        "conflicts": conflicts,
    }


def _apply_compiled_document(item: dict) -> tuple[bytes, object]:
    base_version: DocumentVersion = item["base_version"]
    source_path = document_version_path(base_version)
    if item["editor_targets"]:
        editor_targets = [target[:4] for target in item["editor_targets"]]
        _prepared_docx, payload = _apply_document_targets(source_path, editor_targets)
    else:
        payload = source_path.read_bytes()
    if item["find_patches"]:
        inventory = build_text_inventory(
            payload,
            document_id=item["document"].id,
            version_id=base_version.id,
        )
        payload = apply_text_replacements(payload, inventory, item["find_patches"])
    try:
        prepared_docx = Document(BytesIO(payload))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="A generated batch document failed DOCX validation.",
        ) from exc
    return payload, prepared_docx


def preview_edit_batch(session: Session, batch_id: str) -> dict:
    started = perf_counter()
    batch = get_edit_batch(session, batch_id)
    _require_draft(batch)
    compiled = _compile_edit_batch(session, batch)
    conflicts = compiled["conflicts"]
    validation_ms = (perf_counter() - started) * 1000
    # Preview resolves and validates changes only; it must not generate a DOCX.
    preview_ms = 0.0
    documents = [
        {
            "document_id": document_id,
            "document_name": item["document"].original_name,
            "base_version_id": item["base_version"].id,
            "find_replacement_count": len(item["find_patches"]),
            "editor_target_count": len(item["editor_targets"]),
            "change_count": len(item["find_patches"]) + len(item["editor_targets"]),
            "changes": [
                {
                    "operation_id": operation.id,
                    "operation_type": "editor_replace",
                    "element_id": revision.element_id,
                    "paragraph_index": int((revision.location_json or {}).get("paragraph_index", revision.ordinal)),
                    "element_type": revision.element_type,
                    "location": revision.location_json or {},
                    "before": revision.text,
                    "after": target.replacement_text,
                }
                for target, revision, _document, _delta, operation in item["editor_targets"]
            ] + [
                {
                    "operation_id": operation.id,
                    "operation_type": "find_replace",
                    "occurrence_id": occurrence.occurrence_id,
                    "element_id": occurrence.element_id,
                    "paragraph_index": int((occurrence.location_json or {}).get("paragraph_index", 0)),
                    "element_type": occurrence.structure_type,
                    "location": occurrence.location_json or {},
                    "before": occurrence.matched_text,
                    "after": operation.replacement_text or "",
                }
                for occurrence, operation in item["find_occurrences"]
            ],
        }
        for document_id, item in sorted(
            compiled["documents"].items(),
            key=lambda pair: pair[1]["document"].original_name.casefold(),
        )
    ]
    preview = {
        "batch_id": batch.id,
        "status": "conflicted" if conflicts else "ready",
        "writes_performed": False,
        "conflicts": conflicts,
        "conflict_count": len(conflicts),
        "documents": documents,
        "affected_document_count": len(documents),
        "affected_location_count": sum(item["change_count"] for item in documents),
        "timings": {
            "conflict_validation_ms": round(validation_ms, 2),
            "in_memory_generation_ms": round(preview_ms, 2),
            "total_ms": round((perf_counter() - started) * 1000, 2),
        },
        "state_signature": _batch_state_signature(batch),
    }
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {
        **envelope,
        "preview": preview,
        "affected_document_ids": [item["document_id"] for item in documents],
        "affected_document_names": [item["document_name"] for item in documents],
    }
    session.commit()
    return preview


def queue_edit_batch(session: Session, batch_id: str) -> dict:
    with EDITOR_QUEUE_LOCK:
        batch = get_edit_batch(session, batch_id)
        _require_draft(batch)
        envelope = dict(batch.preview_json or {})
        preview = envelope.get("preview") if isinstance(envelope, dict) else None
        if not isinstance(preview, dict) or preview.get("status") != "ready":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Preview all changes before applying this batch.",
            )
        if preview.get("state_signature") != _batch_state_signature(batch):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Pending changes changed after preview. Preview all changes again.",
            )
        if preview["conflicts"]:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": "Resolve pending batch conflicts before applying changes.",
                    "conflicts": preview["conflicts"],
                },
            )
        affected_ids = set(
            item["document_id"] for item in preview["documents"]
        )
        pending = list(
            session.scalars(
                select(EditorOperation).where(
                    EditorOperation.document_set_id == batch.document_set_id,
                    EditorOperation.id != batch.id,
                    EditorOperation.status.in_(("queued", "processing")),
                )
            )
        )
        for operation in pending:
            envelope = operation.preview_json or {}
            pending_ids = set(
                envelope.get("affected_document_ids", [])
                if isinstance(envelope, dict)
                else []
            )
            overlap = affected_ids & pending_ids
            if overlap:
                names = list(
                    session.scalars(
                        select(DocumentRecord.original_name).where(
                            DocumentRecord.id.in_(overlap)
                        )
                    )
                )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"{', '.join(names) or 'A selected document'} already has "
                        "a background update in progress."
                    ),
                )
        batch.status = "queued"
        batch.stage = "queued"
        batch.error_detail = None
        session.commit()
        return serialize_editor_generation_status(session, batch.id)


def submit_edit_batch(batch_id: str) -> None:
    EDITOR_GENERATION_EXECUTOR.submit(process_queued_edit_batch, batch_id)


def process_queued_edit_batch(batch_id: str) -> None:
    from .database import SessionLocal

    with SessionLocal() as session:
        batch = session.get(EditorOperation, batch_id)
        if batch is None or batch.operation_type != "batch" or batch.status != "queued":
            return
        batch.status = "processing"
        batch.stage = "preparing_documents"
        session.commit()
        try:
            generate_edit_batch(session, batch.id)
        except Exception as exc:
            session.rollback()
            failed = session.get(EditorOperation, batch_id)
            if failed is not None:
                failed.status = "failed"
                failed.stage = "failed"
                failed.error_detail = (
                    str(exc.detail)
                    if isinstance(exc, HTTPException)
                    else str(exc) or "The background batch update failed."
                )
                failed.completed_at = utc_now()
                session.commit()


def _update_batch_progress(
    session: Session,
    batch_id: str,
    *,
    phase: str,
    completed: int,
    total: int,
    document_name: str | None = None,
) -> None:
    batch = session.get(EditorOperation, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Edit batch not found.")
    envelope = dict(batch.preview_json or {})
    batch.preview_json = {
        **envelope,
        "progress": {
            "phase": phase,
            "completed_documents": completed,
            "total_documents": total,
            "current_document_name": document_name,
        },
    }
    session.commit()


def generate_edit_batch(session: Session, batch_id: str) -> dict:
    generation_started = perf_counter()
    timings: dict[str, float] = {}
    with EDITOR_GENERATION_LOCK:
        committed = False
        staging_directory: Path | None = None
        final_directory: Path | None = None
        try:
            batch = get_edit_batch(session, batch_id)
            if batch.status not in {"queued", "processing"}:
                raise HTTPException(
                    status_code=409,
                    detail="Only a queued edit batch can be generated.",
                )
            stage_started = perf_counter()
            compiled = _compile_edit_batch(session, batch)
            timings["conflict_validation_ms"] = (
                perf_counter() - stage_started
            ) * 1000
            if compiled["conflicts"]:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "message": "The batch changed before generation.",
                        "conflicts": compiled["conflicts"],
                    },
                )
            if not compiled["documents"]:
                raise HTTPException(status_code=422, detail="The edit batch is empty.")

            generated_root = settings.data_dir / "generated" / batch.document_set_id
            generated_root.mkdir(parents=True, exist_ok=True)
            staging_directory = generated_root / f".{batch.id}.staging"
            final_directory = generated_root / batch.id
            if staging_directory.exists() or final_directory.exists():
                raise HTTPException(
                    status_code=409,
                    detail="A batch generation storage collision occurred. Try again.",
                )
            staging_directory.mkdir(parents=False, exist_ok=False)
            _commit_editor_generation_stage(session, batch.id, "applying_changes")

            from .document_service import safe_download_name

            staged: dict[str, dict] = {}
            timings["docx_generation_ms"] = 0.0
            timings["file_write_ms"] = 0.0
            total_documents = len(compiled["documents"])
            _update_batch_progress(
                session,
                batch.id,
                phase="generating_documents",
                completed=0,
                total=total_documents,
            )
            for document_index, (document_id, item) in enumerate(
                compiled["documents"].items(),
                start=1,
            ):
                stage_started = perf_counter()
                payload, prepared_docx = _apply_compiled_document(item)
                timings["docx_generation_ms"] += (
                    perf_counter() - stage_started
                ) * 1000
                highest_number = int(
                    session.scalar(
                        select(func.max(DocumentVersion.version_number)).where(
                            DocumentVersion.document_id == document_id
                        )
                    )
                    or item["base_version"].version_number
                )
                next_number = highest_number + 1
                output_name = safe_download_name(
                    f"{Path(item['document'].original_name).stem}-v{next_number}.docx"
                )
                output_path = staging_directory / output_name
                write_started = perf_counter()
                output_path.write_bytes(payload)
                timings["file_write_ms"] += (
                    perf_counter() - write_started
                ) * 1000
                staged[document_id] = {
                    **item,
                    "payload": payload,
                    "prepared_docx": prepared_docx,
                    "version_id": new_id(),
                    "version_number": next_number,
                    "output_name": output_name,
                    "staging_path": output_path,
                    "checksum": hashlib.sha256(payload).hexdigest(),
                }
                _update_batch_progress(
                    session,
                    batch.id,
                    phase="generating_documents",
                    completed=document_index,
                    total=total_documents,
                    document_name=item["document"].original_name,
                )

            _commit_editor_generation_stage(
                session,
                batch.id,
                "validating_generated_files",
            )
            archive_started = perf_counter()
            with zipfile.ZipFile(
                staging_directory / "current-documents.zip",
                mode="w",
                compression=zipfile.ZIP_STORED,
            ) as archive:
                documents = list(
                    session.scalars(
                        select(DocumentRecord)
                        .where(DocumentRecord.document_set_id == batch.document_set_id)
                        .order_by(DocumentRecord.original_name)
                    )
                )
                for document in documents:
                    staged_item = staged.get(document.id)
                    path = (
                        staged_item["staging_path"]
                        if staged_item is not None
                        else document_version_path(
                            current_version_for_document(session, document)
                        )
                    )
                    archive.write(
                        path,
                        arcname=safe_download_name(document.original_name),
                    )
            timings["archive_write_ms"] = (
                perf_counter() - archive_started
            ) * 1000

            _commit_editor_generation_stage(session, batch.id, "saving_new_versions")
            staging_directory.replace(final_directory)
            staging_directory = None
            _commit_editor_generation_stage(session, batch.id, "refreshing_workspace")

            database_started = perf_counter()
            batch = get_edit_batch(session, batch.id)
            batch.status = "completed"
            batch.stage = "completed"
            batch.error_detail = None
            batch.completed_at = utc_now()
            changed_match_hashes: set[str] = set()
            response_versions: list[dict] = []
            timings["block_parsing_and_database_ms"] = 0.0
            for document_id, item in staged.items():
                document: DocumentRecord = item["document"]
                head: DocumentHead = item["head"]
                base_version: DocumentVersion = item["base_version"]
                version = DocumentVersion(
                    id=item["version_id"],
                    document_id=document.id,
                    parent_version_id=base_version.id,
                    generation_id=None,
                    editor_operation_id=batch.id,
                    version_number=item["version_number"],
                    storage_area="generated",
                    storage_name=(
                        f"{batch.document_set_id}/{batch.id}/{item['output_name']}"
                    ),
                    download_name=item["output_name"],
                    checksum_sha256=item["checksum"],
                )
                session.add(version)
                session.flush()

                override_locations: set[str] = set()
                reconnect_locations: set[str] = set()
                for _target, revision, _document, _delta, operation in item[
                    "editor_targets"
                ]:
                    operation_request = _operation_request(operation)
                    editor_request = operation_request.editor_request
                    location_key = _location_key(revision.location_json)
                    if editor_request and editor_request.edit_mode == "override":
                        override_locations.add(location_key)
                    elif revision.shared_state == "detached":
                        reconnect_locations.add(location_key)
                block_started = perf_counter()
                location_to_element = _replace_current_elements_and_create_revisions(
                    session,
                    document=document,
                    version=version,
                    source_path=final_directory / item["output_name"],
                    base_version_id=base_version.id,
                    override_locations=override_locations,
                    reconnect_locations=reconnect_locations,
                    prepared_docx=item["prepared_docx"],
                    changed_match_hashes=changed_match_hashes,
                )
                for ordinal, (
                    target,
                    revision,
                    _target_document,
                    delta,
                    _operation,
                ) in enumerate(item["editor_targets"]):
                    session.add(
                        EditorOperationTarget(
                            id=new_id(),
                            operation_id=batch.id,
                            document_id=document.id,
                            element_id=revision.element_id,
                            base_version_id=base_version.id,
                            result_version_id=version.id,
                            expected_head_revision=head.revision,
                            ordinal=ordinal,
                            before_text=revision.text,
                            after_text=target.replacement_text,
                            before_delta_json=revision.delta_json,
                            after_delta_json=delta,
                        )
                    )
                for occurrence, _operation in item["find_occurrences"]:
                    occurrence.result_version_id = version.id
                head.current_version_id = version.id
                head.revision += 1
                head.updated_at = utc_now()
                response_versions.append(
                    {
                        "id": version.id,
                        "document_id": document.id,
                        "document_name": document.original_name,
                        "version_id": version.id,
                        "version_number": version.version_number,
                        "parent_version_id": version.parent_version_id,
                        "checksum_sha256": version.checksum_sha256,
                        "created_at": utc_isoformat(version.created_at),
                        "status": "completed",
                        "is_current": True,
                        "generation_id": batch.id,
                        "download_url": f"/api/document-versions/{version.id}/download",
                        "editor_content_url": (
                            f"/api/document-versions/{version.id}/editor-content"
                        ),
                        "element_ids_by_location": location_to_element,
                    }
                )
                timings["block_parsing_and_database_ms"] += (
                    perf_counter() - block_started
                ) * 1000

            session.flush()
            from .document_service import (
                _rebuild_exact_link_groups_for_hashes,
                rendered_pdf_path,
            )

            matching_started = perf_counter()
            _rebuild_exact_link_groups_for_hashes(
                session,
                batch.document_set_id,
                changed_match_hashes,
            )
            timings["matching_and_synchronisation_ms"] = (
                perf_counter() - matching_started
            ) * 1000
            for item in staged.values():
                rendered_pdf_path(item["document"]).unlink(missing_ok=True)
            timings["database_update_ms"] = (
                perf_counter() - database_started
            ) * 1000
            envelope = dict(batch.preview_json or {})
            preview = dict(envelope.get("preview") or {})
            preview["status"] = "completed"
            preview["writes_performed"] = True
            batch.preview_json = {
                **envelope,
                "preview": preview,
                "timings": {key: round(value, 2) for key, value in timings.items()},
            }
            commit_started = perf_counter()
            session.commit()
            timings["database_commit_ms"] = (
                perf_counter() - commit_started
            ) * 1000
            committed = True

            preview_started = perf_counter()
            preview_jobs = _queue_previews_safely(
                session,
                [item["version_id"] for item in response_versions],
            )
            timings["deferred_preview_queue_ms"] = (
                perf_counter() - preview_started
            ) * 1000
            generated_versions = [
                session.get(DocumentVersion, item["version_id"])
                for item in response_versions
            ]
            document_updates = _serialize_generated_document_updates(
                session,
                [version for version in generated_versions if version is not None],
            )
            timings["total_ms"] = (perf_counter() - generation_started) * 1000
            return {
                "operation_id": batch.id,
                "generation_id": batch.id,
                "batch_id": batch.id,
                "status": "completed",
                "edit_mode": "batch",
                "versions": sorted(
                    response_versions,
                    key=lambda item: item["document_name"].casefold(),
                ),
                "files": [
                    {
                        "source_document_id": item["document_id"],
                        "version_id": item["version_id"],
                        "name": item["document_name"],
                        "download_url": item["download_url"],
                    }
                    for item in response_versions
                ],
                "download_url": f"/api/editor-operations/{batch.id}/download",
                "preview_jobs": preview_jobs,
                "document_updates": document_updates,
                "timings": {key: round(value, 2) for key, value in timings.items()},
            }
        except Exception:
            if not committed:
                session.rollback()
                if staging_directory is not None:
                    shutil.rmtree(staging_directory, ignore_errors=True)
                if final_directory is not None:
                    shutil.rmtree(final_directory, ignore_errors=True)
            raise
