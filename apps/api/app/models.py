from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class DocumentSet(Base):
    __tablename__ = "document_sets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    documents: Mapped[list[DocumentRecord]] = relationship(
        back_populates="document_set", cascade="all, delete-orphan"
    )
    link_groups: Mapped[list[LinkGroup]] = relationship(
        back_populates="document_set", cascade="all, delete-orphan"
    )
    generations: Mapped[list[GenerationJob]] = relationship(
        back_populates="document_set", cascade="all, delete-orphan"
    )
    match_decisions: Mapped[list[MatchDecision]] = relationship(
        back_populates="document_set", cascade="all, delete-orphan"
    )
    editor_operations: Mapped[list[EditorOperation]] = relationship(
        back_populates="document_set", cascade="all, delete-orphan"
    )


class DocumentRecord(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_set_id: Mapped[str] = mapped_column(
        ForeignKey("document_sets.id", ondelete="CASCADE"), index=True
    )
    original_name: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255), unique=True)
    checksum_sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    document_set: Mapped[DocumentSet] = relationship(back_populates="documents")
    elements: Mapped[list[DocumentElement]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    versions: Mapped[list[DocumentVersion]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        foreign_keys="DocumentVersion.document_id",
    )
    version_head: Mapped[DocumentHead | None] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        foreign_keys="DocumentHead.document_id",
        uselist=False,
    )


class DocumentElement(Base):
    __tablename__ = "document_elements"
    __table_args__ = (
        UniqueConstraint("document_id", "paragraph_index", name="uq_document_paragraph"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    paragraph_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    normalized_text: Mapped[str] = mapped_column(Text, index=True)
    style_name: Mapped[str | None] = mapped_column(String(150), nullable=True)

    document: Mapped[DocumentRecord] = relationship(back_populates="elements")
    link_memberships: Mapped[list[LinkMember]] = relationship(
        back_populates="element", cascade="all, delete-orphan"
    )


class LinkGroup(Base):
    __tablename__ = "link_groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_set_id: Mapped[str] = mapped_column(
        ForeignKey("document_sets.id", ondelete="CASCADE"), index=True
    )
    representative_text: Mapped[str] = mapped_column(Text)
    normalized_text: Mapped[str] = mapped_column(Text)
    match_type: Mapped[str] = mapped_column(String(40), default="exact")

    document_set: Mapped[DocumentSet] = relationship(back_populates="link_groups")
    members: Mapped[list[LinkMember]] = relationship(
        back_populates="link_group", cascade="all, delete-orphan"
    )


class LinkMember(Base):
    __tablename__ = "link_members"
    __table_args__ = (
        UniqueConstraint("link_group_id", "element_id", name="uq_link_group_element"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    link_group_id: Mapped[str] = mapped_column(
        ForeignKey("link_groups.id", ondelete="CASCADE"), index=True
    )
    element_id: Mapped[str] = mapped_column(
        ForeignKey("document_elements.id", ondelete="CASCADE"), index=True
    )

    link_group: Mapped[LinkGroup] = relationship(back_populates="members")
    element: Mapped[DocumentElement] = relationship(back_populates="link_memberships")


class GenerationJob(Base):
    __tablename__ = "generation_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_set_id: Mapped[str] = mapped_column(
        ForeignKey("document_sets.id", ondelete="CASCADE"), index=True
    )
    link_group_id: Mapped[str] = mapped_column(String(36), index=True)
    replacement_text: Mapped[str] = mapped_column(Text)
    zip_storage_name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(30), default="completed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    document_set: Mapped[DocumentSet] = relationship(back_populates="generations")
    versions: Mapped[list[GeneratedVersion]] = relationship(
        back_populates="generation", cascade="all, delete-orphan"
    )
    targets: Mapped[list[GenerationTarget]] = relationship(
        back_populates="generation", cascade="all, delete-orphan"
    )


class GeneratedVersion(Base):
    __tablename__ = "generated_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    generation_id: Mapped[str] = mapped_column(
        ForeignKey("generation_jobs.id", ondelete="CASCADE"), index=True
    )
    source_document_id: Mapped[str] = mapped_column(String(36), index=True)
    download_name: Mapped[str] = mapped_column(String(255))
    storage_name: Mapped[str] = mapped_column(String(255), unique=True)

    generation: Mapped[GenerationJob] = relationship(back_populates="versions")


class GenerationTarget(Base):
    """Immutable audit detail for every confirmed element in a generation."""

    __tablename__ = "generation_targets"
    __table_args__ = (
        UniqueConstraint("generation_id", "element_id", name="uq_generation_element"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    generation_id: Mapped[str] = mapped_column(
        ForeignKey("generation_jobs.id", ondelete="CASCADE"), index=True
    )
    element_id: Mapped[str] = mapped_column(String(36), index=True)
    document_id: Mapped[str] = mapped_column(String(36), index=True)
    document_name: Mapped[str] = mapped_column(String(255))
    paragraph_index: Mapped[int] = mapped_column(Integer)
    before_text: Mapped[str] = mapped_column(Text)
    after_text: Mapped[str] = mapped_column(Text)

    generation: Mapped[GenerationJob] = relationship(back_populates="targets")


class DocumentVersion(Base):
    """Immutable file-level version in a document's explicit lineage."""

    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint(
            "document_id",
            "version_number",
            name="uq_document_version_number",
        ),
        UniqueConstraint(
            "generation_id",
            "document_id",
            name="uq_document_version_generation",
        ),
        UniqueConstraint(
            "storage_area",
            "storage_name",
            name="uq_document_version_storage",
        ),
        CheckConstraint("version_number > 0", name="ck_document_version_number_positive"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    parent_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("document_versions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    generation_id: Mapped[str | None] = mapped_column(
        ForeignKey("generation_jobs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    editor_operation_id: Mapped[str | None] = mapped_column(
        ForeignKey("editor_operations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer)
    storage_area: Mapped[str] = mapped_column(String(30))
    storage_name: Mapped[str] = mapped_column(String(255))
    download_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    document: Mapped[DocumentRecord] = relationship(
        back_populates="versions",
        foreign_keys=[document_id],
    )
    parent_version: Mapped[DocumentVersion | None] = relationship(
        remote_side=[id],
        back_populates="child_versions",
        foreign_keys=[parent_version_id],
    )
    child_versions: Mapped[list[DocumentVersion]] = relationship(
        back_populates="parent_version",
        foreign_keys=[parent_version_id],
    )
    blocks: Mapped[list[DocumentBlockRevision]] = relationship(
        back_populates="version",
        cascade="all, delete-orphan",
        order_by="DocumentBlockRevision.ordinal",
    )
    editor_operation: Mapped[EditorOperation | None] = relationship(
        back_populates="versions",
        foreign_keys=[editor_operation_id],
    )


class DocumentHead(Base):
    """Mutable pointer used for atomic current-version checks."""

    __tablename__ = "document_heads"
    __table_args__ = (
        CheckConstraint("revision > 0", name="ck_document_head_revision_positive"),
    )

    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    current_version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )

    document: Mapped[DocumentRecord] = relationship(
        back_populates="version_head",
        foreign_keys=[document_id],
    )
    current_version: Mapped[DocumentVersion] = relationship(
        foreign_keys=[current_version_id]
    )


class PreviewRenderJob(Base):
    """Durable, version-bound Microsoft Word preview work item."""

    __tablename__ = "preview_render_jobs"
    __table_args__ = (
        Index(
            "ix_preview_render_job_version_created",
            "version_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    stage: Mapped[str] = mapped_column(String(60), default="queued")
    pdf_ready: Mapped[bool] = mapped_column(Boolean, default=False)
    render_map_ready: Mapped[bool] = mapped_column(Boolean, default=False)
    render_map_status: Mapped[str] = mapped_column(
        String(30), default="not_requested"
    )
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False)
    stale_preview_available: Mapped[bool] = mapped_column(Boolean, default=False)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class DocumentPreviewCache(Base):
    """Durable, version-keyed payload for immediate document opening.

    Large PDF and page-image binaries remain on disk. SQLite stores the
    processed preview description and the source/PDF identity needed to decide
    whether those files can be reused safely.
    """

    __tablename__ = "document_preview_caches"

    version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_mtime_ns: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pdf_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pdf_mtime_ns: Mapped[int | None] = mapped_column(Integer, nullable=True)
    structured_preview_json: Mapped[dict | list | None] = mapped_column(
        JSON, nullable=True
    )
    word_preview_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    refresh_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class DocumentBlockRevision(Base):
    """Immutable editor/write-back snapshot for one block in one version."""

    __tablename__ = "document_block_revisions"
    __table_args__ = (
        UniqueConstraint(
            "version_id",
            "element_id",
            name="uq_document_block_revision_element",
        ),
        CheckConstraint("ordinal >= 0", name="ck_document_block_revision_ordinal"),
        CheckConstraint(
            "list_level IS NULL OR list_level >= 0",
            name="ck_document_block_revision_list_level",
        ),
        CheckConstraint(
            "shared_state IN ('shared', 'detached')",
            name="ck_document_block_revision_shared_state",
        ),
        Index(
            "ix_document_block_revision_document_ordinal",
            "document_id",
            "ordinal",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    # Deliberately not a foreign key: historical block identity must survive an
    # element being replaced in a later document version.
    element_id: Mapped[str] = mapped_column(String(36), index=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    element_type: Mapped[str] = mapped_column(String(40))
    text: Mapped[str] = mapped_column(Text)
    normalized_text: Mapped[str] = mapped_column(Text, index=True)
    exact_match_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    structure_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    delta_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    formatting_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    list_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    list_level: Mapped[int | None] = mapped_column(Integer, nullable=True)
    alignment: Mapped[str | None] = mapped_column(String(30), nullable=True)
    location_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    shared_state: Mapped[str] = mapped_column(String(20), default="shared")
    supported: Mapped[bool] = mapped_column(Boolean, default=True)
    unsupported_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    version: Mapped[DocumentVersion] = relationship(back_populates="blocks")


class MatchDecision(Base):
    """Persisted user review state for a version-specific near-match pair."""

    __tablename__ = "match_decisions"
    __table_args__ = (
        UniqueConstraint(
            "source_version_id",
            "source_element_id",
            "candidate_version_id",
            "candidate_element_id",
            name="uq_match_decision_pair",
        ),
        CheckConstraint(
            "similarity_score IS NULL OR "
            "(similarity_score >= 0 AND similarity_score <= 1)",
            name="ck_match_decision_similarity",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_set_id: Mapped[str] = mapped_column(
        ForeignKey("document_sets.id", ondelete="CASCADE"), index=True
    )
    source_element_id: Mapped[str] = mapped_column(String(36), index=True)
    candidate_element_id: Mapped[str] = mapped_column(String(36), index=True)
    source_version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    candidate_version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    decision: Mapped[str] = mapped_column(String(30))
    similarity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    algorithm_version: Mapped[str] = mapped_column(String(60), default="token-sequence-v1")
    difference_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    decided_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )

    document_set: Mapped[DocumentSet] = relationship(back_populates="match_decisions")
    source_version: Mapped[DocumentVersion] = relationship(
        foreign_keys=[source_version_id]
    )
    candidate_version: Mapped[DocumentVersion] = relationship(
        foreign_keys=[candidate_version_id]
    )


class EditorOperation(Base):
    """Preview/generation audit envelope for one confirmed editor request."""

    __tablename__ = "editor_operations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_set_id: Mapped[str] = mapped_column(
        ForeignKey("document_sets.id", ondelete="CASCADE"), index=True
    )
    operation_type: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(30), default="previewed")
    stage: Mapped[str] = mapped_column(String(60), default="queued")
    source_element_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    link_group_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    replacement_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    expected_head_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preview_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    document_set: Mapped[DocumentSet] = relationship(back_populates="editor_operations")
    targets: Mapped[list[EditorOperationTarget]] = relationship(
        back_populates="operation",
        cascade="all, delete-orphan",
    )
    batch_operations: Mapped[list[EditBatchOperation]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="EditBatchOperation.operation_index",
    )
    versions: Mapped[list[DocumentVersion]] = relationship(
        back_populates="editor_operation",
        foreign_keys="DocumentVersion.editor_operation_id",
    )


class EditorOperationTarget(Base):
    """Immutable per-block before/after audit detail for an editor operation."""

    __tablename__ = "editor_operation_targets"
    __table_args__ = (
        UniqueConstraint(
            "operation_id",
            "document_id",
            "element_id",
            name="uq_editor_operation_target",
        ),
        CheckConstraint("ordinal >= 0", name="ck_editor_operation_target_ordinal"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("editor_operations.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    element_id: Mapped[str] = mapped_column(String(36), index=True)
    base_version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    result_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("document_versions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    expected_head_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    before_text: Mapped[str] = mapped_column(Text)
    after_text: Mapped[str] = mapped_column(Text)
    before_delta_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    after_delta_json: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    operation: Mapped[EditorOperation] = relationship(back_populates="targets")
    base_version: Mapped[DocumentVersion] = relationship(
        foreign_keys=[base_version_id]
    )
    result_version: Mapped[DocumentVersion | None] = relationship(
        foreign_keys=[result_version_id]
    )


class EditBatchOperation(Base):
    """One ordered, independently reviewable operation in a durable edit batch."""

    __tablename__ = "edit_batch_operations"
    __table_args__ = (
        UniqueConstraint(
            "batch_id",
            "operation_index",
            name="uq_edit_batch_operation_index",
        ),
        CheckConstraint(
            "operation_index >= 0",
            name="ck_edit_batch_operation_index",
        ),
        CheckConstraint(
            "operation_type IN ('find_replace', 'editor_replace')",
            name="ck_edit_batch_operation_type",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("editor_operations.id", ondelete="CASCADE"), index=True
    )
    operation_index: Mapped[int] = mapped_column(Integer)
    operation_type: Mapped[str] = mapped_column(String(40))
    label: Mapped[str | None] = mapped_column(String(240), nullable=True)
    replacement_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_json: Mapped[dict | list] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
    )

    batch: Mapped[EditorOperation] = relationship(back_populates="batch_operations")
    occurrences: Mapped[list[EditBatchOccurrence]] = relationship(
        back_populates="batch_operation",
        cascade="all, delete-orphan",
        order_by="EditBatchOccurrence.created_at",
    )


class EditBatchOccurrence(Base):
    """Version-bound occurrence selected for a find-and-replace operation."""

    __tablename__ = "edit_batch_occurrences"
    __table_args__ = (
        UniqueConstraint(
            "batch_operation_id",
            "occurrence_id",
            name="uq_edit_batch_occurrence",
        ),
        CheckConstraint(
            "match_start >= 0 AND match_end > match_start",
            name="ck_edit_batch_occurrence_range",
        ),
        Index(
            "ix_edit_batch_occurrence_document_version",
            "document_id",
            "base_version_id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    batch_operation_id: Mapped[str] = mapped_column(
        ForeignKey("edit_batch_operations.id", ondelete="CASCADE"), index=True
    )
    occurrence_id: Mapped[str] = mapped_column(String(36))
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    base_version_id: Mapped[str] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    result_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("document_versions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    segment_id: Mapped[str] = mapped_column(String(36), index=True)
    element_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    part_path: Mapped[str] = mapped_column(String(400))
    structure_type: Mapped[str] = mapped_column(String(60))
    match_start: Mapped[int] = mapped_column(Integer)
    match_end: Mapped[int] = mapped_column(Integer)
    matched_text: Mapped[str] = mapped_column(Text)
    location_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    selected: Mapped[bool] = mapped_column(Boolean, default=True)
    editable: Mapped[bool] = mapped_column(Boolean, default=True)
    read_only_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    batch_operation: Mapped[EditBatchOperation] = relationship(
        back_populates="occurrences"
    )
    base_version: Mapped[DocumentVersion] = relationship(
        foreign_keys=[base_version_id]
    )
    result_version: Mapped[DocumentVersion | None] = relationship(
        foreign_keys=[result_version_id]
    )
