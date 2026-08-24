from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator


class EditRequest(BaseModel):
    link_group_id: str = Field(min_length=1, max_length=36)
    replacement_text: str = Field(min_length=1, max_length=20_000)
    source_element_id: str | None = Field(default=None, min_length=1, max_length=36)
    included_element_ids: list[str] | None = Field(
        default=None,
        min_length=1,
        max_length=500,
    )

    @field_validator("replacement_text")
    @classmethod
    def replacement_must_contain_visible_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Replacement text cannot be blank.")
        return cleaned

    @field_validator("included_element_ids")
    @classmethod
    def included_elements_must_be_unique(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if any(not element_id.strip() for element_id in value):
            raise ValueError("Included element IDs cannot be blank.")
        if len(set(value)) != len(value):
            raise ValueError("Included element IDs must be unique.")
        return value


class DeltaOperation(BaseModel):
    """A safe subset of a Quill 2 Delta operation.

    Editor requests contain full single-block contents, not structural patch
    operations. ``retain`` and ``delete`` are represented here so that the API
    can return a specific unsupported-operation error instead of treating the
    request as malformed JSON.
    """

    insert: str | None = None
    retain: int | None = Field(default=None, ge=0)
    delete: int | None = Field(default=None, ge=0)
    attributes: dict[str, Any] | None = None

    @model_validator(mode="after")
    def exactly_one_operation(self) -> "DeltaOperation":
        supplied = sum(
            value is not None for value in (self.insert, self.retain, self.delete)
        )
        if supplied != 1:
            raise ValueError("Each Delta operation must contain exactly one operation.")
        return self


class QuillDelta(BaseModel):
    ops: list[DeltaOperation] = Field(min_length=1, max_length=2_000)


class EditorTarget(BaseModel):
    element_id: str = Field(min_length=1, max_length=36)
    replacement_text: str = Field(max_length=20_000)
    delta: QuillDelta | None = None

    @field_validator("replacement_text")
    @classmethod
    def replacement_must_be_visible(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Replacement text cannot be blank.")
        return value


class EditorMatchDecision(BaseModel):
    candidate_element_id: str = Field(
        min_length=1,
        max_length=36,
        validation_alias=AliasChoices("candidate_element_id", "element_id"),
    )
    status: Literal["confirmed", "ignored", "removed"] = Field(
        validation_alias=AliasChoices("status", "decision")
    )


class EditorEditRequest(BaseModel):
    base_versions: dict[str, str] = Field(min_length=1, max_length=20)
    source_element_id: str = Field(min_length=1, max_length=36)
    edit_mode: Literal["shared", "per_document", "override"] = "shared"
    targets: list[EditorTarget] = Field(min_length=1, max_length=500)
    match_decisions: list[EditorMatchDecision] = Field(
        default_factory=list,
        max_length=500,
    )

    @field_validator("base_versions")
    @classmethod
    def base_versions_must_be_valid(cls, value: dict[str, str]) -> dict[str, str]:
        if any(
            not document_id.strip()
            or len(document_id) > 36
            or not version_id.strip()
            or len(version_id) > 36
            for document_id, version_id in value.items()
        ):
            raise ValueError("Base document and version IDs must be non-blank UUID values.")
        return value

    @field_validator("edit_mode", mode="before")
    @classmethod
    def normalise_full_override_alias(cls, value: object) -> object:
        return "override" if value == "full_override" else value

    @field_validator("targets")
    @classmethod
    def targets_must_be_unique(cls, value: list[EditorTarget]) -> list[EditorTarget]:
        element_ids = [target.element_id for target in value]
        if len(element_ids) != len(set(element_ids)):
            raise ValueError("Editor target element IDs must be unique.")
        return value

    @field_validator("match_decisions")
    @classmethod
    def decisions_must_be_unique(
        cls,
        value: list[EditorMatchDecision],
    ) -> list[EditorMatchDecision]:
        candidate_ids = [decision.candidate_element_id for decision in value]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("Each candidate may have only one match decision.")
        return value


class CompareRequest(BaseModel):
    candidate_element_ids: list[str] | None = Field(
        default=None,
        max_length=100,
        validation_alias=AliasChoices(
            "candidate_element_ids",
            "element_ids",
            "target_element_ids",
        ),
    )
    include_near_matches: bool = True
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    limit: int = Field(default=20, ge=1, le=100)

    @field_validator("candidate_element_ids")
    @classmethod
    def comparison_candidates_must_be_unique(
        cls,
        value: list[str] | None,
    ) -> list[str] | None:
        if value is None:
            return None
        if not value:
            raise ValueError("Choose at least one candidate element.")
        if any(not candidate.strip() or len(candidate) > 36 for candidate in value):
            raise ValueError("Candidate element IDs must be non-blank UUID values.")
        if len(value) != len(set(value)):
            raise ValueError("Candidate element IDs must be unique.")
        return value


class MatchDecisionBatchRequest(BaseModel):
    decisions: list[EditorMatchDecision] = Field(min_length=1, max_length=500)

    @field_validator("decisions")
    @classmethod
    def decisions_must_be_unique(
        cls,
        value: list[EditorMatchDecision],
    ) -> list[EditorMatchDecision]:
        candidate_ids = [decision.candidate_element_id for decision in value]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("Each candidate may have only one match decision.")
        return value


class VersionRestoreRequest(BaseModel):
    expected_current_version_id: str = Field(min_length=1, max_length=36)

    @field_validator("expected_current_version_id")
    @classmethod
    def expected_version_must_be_visible(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("The expected current version ID cannot be blank.")
        return value


class TextSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    document_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)
    match_case: bool = False
    whole_word: bool = False
    include_comments: bool = False
    include_historical_tracked_text: bool = False
    include_field_instructions: bool = False
    limit: int | None = Field(default=10_000, ge=1, le=20_000)

    @field_validator("query")
    @classmethod
    def query_must_contain_searchable_text(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("Find text cannot be blank.")
        return value

    @field_validator("document_ids")
    @classmethod
    def document_scope_must_be_unique(
        cls,
        value: list[str] | None,
    ) -> list[str] | None:
        if value is None:
            return None
        if any(not document_id.strip() or len(document_id) > 36 for document_id in value):
            raise ValueError("Document scope IDs must be non-blank UUID values.")
        if len(value) != len(set(value)):
            raise ValueError("Document scope IDs must be unique.")
        return value


class FindReplaceOccurrenceTarget(BaseModel):
    occurrence_id: str = Field(min_length=1, max_length=36)
    segment_id: str = Field(min_length=1, max_length=36)
    document_id: str = Field(min_length=1, max_length=36)
    version_id: str = Field(min_length=1, max_length=36)
    element_id: str | None = Field(default=None, max_length=36)
    part_path: str = Field(min_length=1, max_length=400)
    structure_type: str = Field(min_length=1, max_length=60)
    match_start: int = Field(ge=0)
    match_end: int = Field(gt=0)
    matched_text: str = Field(min_length=1, max_length=20_000)
    location: dict[str, Any] = Field(default_factory=dict)
    editable: bool = True
    read_only_reason: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def range_must_match_text(self) -> "FindReplaceOccurrenceTarget":
        if self.match_end <= self.match_start:
            raise ValueError("Occurrence end must be after its start.")
        return self


class EditBatchCreate(BaseModel):
    title: str = Field(default="Pending changes", min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def title_must_be_visible(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Batch title cannot be blank.")
        return cleaned


class EditBatchOperationRequest(BaseModel):
    operation_type: Literal["find_replace", "editor_replace"]
    label: str | None = Field(default=None, max_length=240)
    replacement_text: str | None = Field(default=None, max_length=20_000)
    find_request: TextSearchRequest | None = None
    occurrences: list[FindReplaceOccurrenceTarget] = Field(
        default_factory=list,
        max_length=20_000,
    )
    editor_request: EditorEditRequest | None = None
    enabled: bool = True

    @model_validator(mode="after")
    def validate_operation_payload(self) -> "EditBatchOperationRequest":
        if self.operation_type == "find_replace":
            if self.replacement_text is None:
                raise ValueError("Find-and-replace operations require replacement text.")
            if self.find_request is None:
                raise ValueError("Find-and-replace operations require search options.")
            if not self.occurrences:
                raise ValueError("Select at least one editable occurrence.")
            if self.editor_request is not None:
                raise ValueError("Find-and-replace operations cannot contain an editor request.")
            occurrence_ids = [item.occurrence_id for item in self.occurrences]
            if len(occurrence_ids) != len(set(occurrence_ids)):
                raise ValueError("Selected occurrence IDs must be unique.")
        else:
            if self.editor_request is None:
                raise ValueError("Editor operations require an editor request.")
            if self.occurrences or self.find_request is not None:
                raise ValueError("Editor operations cannot contain find occurrences.")
        return self


class EditBatchOccurrenceSelectionRequest(BaseModel):
    selected: bool
