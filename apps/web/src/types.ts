export interface DocumentSummary {
  id: string;
  version_id: string;
  current_version_id?: string;
  version_number?: number;
  name: string;
  checksum_sha256: string;
  element_count: number;
  view_url: string;
  download_url?: string;
}

export interface LinkMember {
  element_id: string;
  document_id: string;
  document_name: string;
  paragraph_index: number;
  element_type: "paragraph" | "heading" | "list_item" | "table_cell" | "table_paragraph" | "header_paragraph" | "footer_paragraph";
  text: string;
  style_name: string | null;
  table_index?: number;
  row_index?: number;
  column_index?: number;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
}

export type HeaderFooterType =
  | "default_header"
  | "default_footer"
  | "first_page_header"
  | "first_page_footer"
  | "even_page_header"
  | "even_page_footer";

export interface ViewerElement {
  id: string;
  document_id: string;
  paragraph_index: number;
  element_type: "paragraph" | "heading" | "list_item" | "table_cell" | "table_paragraph" | "header_paragraph" | "footer_paragraph";
  text: string;
  style_name: string | null;
  table_index?: number;
  row_index?: number;
  column_index?: number;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
  page_number: number;
}

export interface ViewerPage {
  page_number: number;
  elements: ViewerElement[];
}

export interface LayoutElementRegion {
  element_id: string;
  document_id: string;
  version_id: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  editable: boolean;
  confidence?: number;
}

export type RenderMapStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "completed"
  | "partial"
  | "failed";

export interface RenderMapPage {
  page_id: string;
  page_number: number;
  page_width: number;
  page_height: number;
  width: number;
  height: number;
  aspect_ratio: number;
  image_width: number;
  image_height: number;
  image_url: string;
  coordinate_unit: "normalised";
  render_version: string;
}

export interface RenderMapRegion extends LayoutElementRegion {
  region_id: string;
  region_index: number;
  render_id?: string | null;
  element_type: string;
  text_preview: string;
  location: Record<string, unknown>;
  confidence: number;
  mapping_method: string;
  interactive: boolean;
  supported: boolean;
  read_only: boolean;
  reason?: string | null;
  read_only_reason?: string | null;
}

export interface RenderMapResponse {
  schema_version: number;
  version_id: string;
  document_id: string;
  document_set_id: string;
  status: RenderMapStatus;
  status_detail: string;
  map_engine: string;
  mapper: string;
  mapper_version: string;
  pdf_engine: string;
  coordinate_unit: "normalised";
  source_sha256?: string | null;
  pdf_sha256?: string | null;
  interactive_threshold: number;
  render_id?: string | null;
  render_version?: string | null;
  page_count: number;
  pages: RenderMapPage[];
  regions: RenderMapRegion[];
  mapped_element_count: number;
  interactive_element_count: number;
  total_element_count: number;
  unmapped: Array<{
    element_id: string;
    element_type: string;
    reason: string;
  }>;
  generated_at?: string | null;
}

export type PreviewRenderStage =
  | "queued"
  | "starting_microsoft_word"
  | "opening_document"
  | "rendering_pdf"
  | "displaying_document"
  | "preparing_selectable_text"
  | "ready_to_edit"
  | "failed"
  | string;

export interface PreviewRenderJobResponse {
  job_id: string;
  document_id: string;
  version_id: string;
  status: "queued" | "processing" | "completed" | "failed" | string;
  stage: PreviewRenderStage;
  pdf_ready: boolean;
  render_map_ready: boolean;
  render_map_status: RenderMapStatus;
  cache_hit: boolean;
  stale_preview_available: boolean;
  cached_preview?: DocumentView;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  error?: string | null;
  status_url: string;
  preview_url: string;
  render_map_url: string;
  retry_allowed: boolean;
}

export interface DocumentView {
  document_id: string;
  version_id: string;
  document_set_id: string;
  document_name: string;
  render_status: "ready" | "rendering" | "failed" | string;
  render_mode: "word_pdf" | "structured" | string;
  pagination: "word" | "estimated" | string;
  page_count: number;
  notice: string;
  pdf_url?: string;
  render_map_status?: RenderMapStatus;
  render_map_url?: string;
  pages: ViewerPage[];
  layout_regions?: LayoutElementRegion[];
  preview_cache_status?: "fresh" | "stale" | string;
}

export interface MatchDiscovery {
  source: {
    element_id: string;
    document_id: string;
    document_name: string;
    paragraph_index: number;
    element_type: string;
    text: string;
    style_name: string | null;
    table_index?: number;
    row_index?: number;
    column_index?: number;
  };
  link_group: LinkGroup | null;
  exact_matches?: EditorMatch[];
  exact_match_count: number;
  similar_matches: LinkMember[];
  similarity_status: "not_enabled" | string;
}

export interface LinkGroup {
  id: string;
  match_type: "exact" | string;
  representative_text: string;
  member_count: number;
  document_count: number;
  members: LinkMember[];
}

export interface DocumentSetLibraryItem {
  id: string;
  name: string;
  created_at: string;
  document_count: number;
  edit_count: number;
}

export interface DocumentSetLibraryResponse {
  document_sets: DocumentSetLibraryItem[];
}

export interface DocumentSetResponse {
  id: string;
  name: string;
  created_at: string;
  documents: DocumentSummary[];
  link_group_count: number;
  link_groups: LinkGroup[];
}

export interface GlobalSearchResult {
  result_id: string;
  element_id: string;
  document_id: string;
  document_name: string;
  version_id: string;
  paragraph_index: number;
  element_type: "paragraph" | "heading" | "list_item" | "table_cell" | "table_paragraph" | "header_paragraph" | "footer_paragraph";
  table_index?: number;
  row_index?: number;
  column_index?: number;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
  text: string;
  occurrence_index: number;
  match_start: number;
  match_end: number;
  context_before: string;
  matched_text: string;
  context_after: string;
}

export interface GlobalSearchDocumentCount {
  document_id: string;
  document_name: string;
  result_count: number;
}

export interface GlobalSearchResponse {
  query: string;
  results: GlobalSearchResult[];
  result_count: number;
  returned_count: number;
  document_count: number;
  document_counts: GlobalSearchDocumentCount[];
  truncated: boolean;
}

export interface DocumentSearchTarget {
  request_id: number;
  document_id: string;
  element_id: string;
  query: string;
  occurrence_index: number;
  match_start: number;
  match_end: number;
}

export interface PreviewChange {
  element_id: string;
  paragraph_index: number;
  element_type: string;
  table_index?: number;
  row_index?: number;
  column_index?: number;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
  linked_sections?: number[];
  before: string;
  after: string;
}

export interface PreviewDocument {
  document_id: string;
  document_name: string;
  changes: PreviewChange[];
}

export interface PreviewResponse {
  link_group_id: string;
  source_element_id: string | null;
  replacement_text: string;
  affected_document_count: number;
  affected_location_count: number;
  documents: PreviewDocument[];
}

export interface GenerationResponse {
  generation_id: string;
  status: string;
  files: Array<{
    source_document_id: string;
    name: string;
  }>;
  download_url: string;
  document_set: DocumentSetResponse;
}

export type QuillAttributes = Record<string, string | number | boolean | null>;

export interface QuillOperation {
  insert?: string | Record<string, unknown>;
  retain?: number;
  delete?: number;
  attributes?: QuillAttributes;
}

export interface QuillDelta {
  ops: QuillOperation[];
}

export interface QuillDraft {
  delta: QuillDelta;
  text: string;
}

export type EditorElementType =
  | "paragraph"
  | "heading"
  | "list_item"
  | "table_cell"
  | "table_paragraph"
  | "header_paragraph"
  | "footer_paragraph"
  | "unsupported"
  | string;

export interface EditorBlock {
  element_id: string;
  document_id: string;
  version_id: string;
  element_type: EditorElementType;
  paragraph_index: number;
  order: number;
  page_number?: number;
  text: string;
  normalized_text?: string;
  exact_match_hash?: string;
  structure_hash?: string | null;
  delta: QuillDelta;
  style_name?: string | null;
  supported: boolean;
  read_only: boolean;
  unsupported_reason?: string | null;
  list_type?: "ordered" | "bullet" | null;
  indent?: number;
  alignment?: "left" | "center" | "right" | "justify" | null;
  table_index?: number;
  row_index?: number;
  column_index?: number;
  document_order?: number;
  kind?: "header_paragraph" | "footer_paragraph" | "body" | "table_paragraph" | string;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
  part_relationship_id?: string;
  is_linked_to_previous?: boolean;
  section_indexes?: number[];
  linked_section_indexes?: number[];
  linked_sections?: number[];
  affected_header_footer_types?: HeaderFooterType[];
}

export interface EditorContentResponse {
  document_id: string;
  version_id: string;
  document_name: string;
  version_number?: number;
  created_at?: string;
  blocks: EditorBlock[];
  unsupported_count: number;
  unsupported: EditorDiagnostic[];
  notice?: string;
}

export interface EditorDiagnostic {
  id?: string;
  element_type: string;
  reason: string;
  location?: string;
  text?: string;
}

export type MatchType = "source" | "exact" | "near";
export type MatchDecision = "pending" | "confirmed" | "ignored" | "removed";

export type DifferenceKind =
  | "equal"
  | "insert"
  | "delete"
  | "changed"
  | "shared"
  | "different";

export interface DifferenceSpan {
  text: string;
  kind: DifferenceKind;
}

export interface EditorMatch {
  element_id: string;
  document_id: string;
  document_name: string;
  version_id?: string;
  paragraph_index: number;
  element_type: EditorElementType;
  text: string;
  style_name?: string | null;
  match_type: MatchType;
  similarity_score: number;
  decision: MatchDecision;
  difference_spans: DifferenceSpan[];
  table_index?: number;
  row_index?: number;
  column_index?: number;
  document_order?: number;
  section_index?: number;
  source_section_index?: number;
  header_footer_type?: HeaderFooterType;
  is_linked_to_previous?: boolean;
  linked_sections?: number[];
}

export interface SimilarMatchesResponse {
  source_element_id: string;
  matches: EditorMatch[];
  threshold?: number;
}

export interface CompareResponse {
  source_element_id: string;
  items: EditorMatch[];
  shared_spans?: DifferenceSpan[];
}

export type EditorEditMode =
  | "shared"
  | "per_document"
  | "full_override";

export interface EditorTarget {
  element_id: string;
  replacement_text: string;
  delta?: QuillDelta;
}

export interface MatchDecisionPayload {
  element_id: string;
  decision: MatchDecision;
}

export interface EditorOperationRequest {
  base_versions: Record<string, string>;
  source_element_id: string;
  edit_mode: EditorEditMode;
  targets: EditorTarget[];
  match_decisions: MatchDecisionPayload[];
}

export interface EditorPreviewChange extends PreviewChange {
  delta?: QuillDelta;
  match_type?: MatchType;
}

export interface EditorPreviewDocument {
  document_id: string;
  document_name: string;
  version_id?: string;
  changes: EditorPreviewChange[];
}

export interface EditorPreviewResponse {
  operation_id?: string;
  source_element_id: string;
  edit_mode: EditorEditMode;
  affected_document_count: number;
  affected_location_count: number;
  documents: EditorPreviewDocument[];
  warnings?: string[];
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  parent_version_id?: string | null;
  created_at: string;
  status: string;
  is_current: boolean;
  download_url?: string;
  generation_id?: string | null;
  operation_type?: string | null;
  restored_from_version_id?: string | null;
  restored_from_version_number?: number | null;
}

export interface DocumentVersionsResponse {
  document_id: string;
  current_version_id: string;
  versions: DocumentVersion[];
}

export interface DocumentVersionRestoreResponse {
  operation_id: string;
  generation_id?: string;
  operation_type: string;
  status: string;
  document_id: string;
  document_name: string;
  restored_from_version_id: string;
  restored_from_version_number: number;
  previous_current_version_id: string;
  version: DocumentVersion;
  download_url?: string;
  document_set: DocumentSetResponse;
}

export interface EditorGenerationResponse {
  id?: string;
  job_id?: string;
  operation_id?: string;
  generation_id: string;
  status: "queued" | "processing" | "completed" | "failed" | "interrupted" | string;
  stage?: string;
  submitted_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  status_url?: string;
  error_detail?: string;
  error?: string | null;
  affected_document_ids?: string[];
  affected_documents?: Array<{ id: string; name: string }>;
  result_version_ids?: string[];
  affected_document_count?: number;
  affected_location_count?: number;
  timings?: Record<string, number>;
  progress?: {
    phase: string;
    completed_documents: number;
    total_documents: number;
    current_document_name?: string | null;
  } | null;
  download_url?: string;
  document_set?: DocumentSetResponse;
  document_updates?: DocumentSummary[];
  versions?: DocumentVersion[];
  files?: Array<{
    source_document_id: string;
    version_id?: string;
    name: string;
    download_url?: string;
  }>;
}

export interface EditorGenerationListResponse {
  jobs: EditorGenerationResponse[];
}

export interface FindReplaceSearchOptions {
  query: string;
  document_ids?: string[];
  match_case?: boolean;
  whole_word?: boolean;
  include_comments?: boolean;
  include_historical_tracked_text?: boolean;
  include_field_instructions?: boolean;
  limit?: number | null;
}

export interface FindReplaceOccurrence {
  occurrence_id: string;
  result_id: string;
  segment_id: string;
  element_id?: string | null;
  revision_id?: string | null;
  document_id: string;
  document_name: string;
  version_id: string;
  part_path: string;
  structure_type: string;
  segment_structure_type: string;
  location: Record<string, unknown>;
  location_label: string;
  match_start: number;
  match_end: number;
  context_before: string;
  matched_text: string;
  context_after: string;
  editable: boolean;
  read_only: boolean;
  read_only_reason?: string | null;
}

export interface FindReplaceSearchResponse {
  query: string;
  options: Omit<FindReplaceSearchOptions, "query" | "document_ids" | "limit">;
  results: FindReplaceOccurrence[];
  result_count: number;
  returned_count: number;
  editable_count: number;
  read_only_count: number;
  document_count: number;
  document_counts: Array<{
    document_id: string;
    document_name: string;
    result_count: number;
    editable_count: number;
    read_only_count: number;
  }>;
  truncated: boolean;
  candidate_engine: string;
  scanned_document_count: number;
  scanned_segment_count: number;
  timings: Record<string, number>;
}

export interface FindReplaceOccurrenceTarget {
  occurrence_id: string;
  segment_id: string;
  document_id: string;
  version_id: string;
  element_id?: string | null;
  part_path: string;
  structure_type: string;
  match_start: number;
  match_end: number;
  matched_text: string;
  location: Record<string, unknown>;
  editable: boolean;
  read_only_reason?: string | null;
}

export interface EditBatchOperationInput {
  operation_type: "find_replace" | "editor_replace";
  label?: string | null;
  replacement_text?: string | null;
  find_request?: FindReplaceSearchOptions | null;
  occurrences?: FindReplaceOccurrenceTarget[];
  editor_request?: EditorOperationRequest | null;
  enabled?: boolean;
}

export interface EditBatchOccurrence extends FindReplaceOccurrenceTarget {
  id: string;
  document_name: string;
  base_version_id: string;
  result_version_id?: string | null;
  selected: boolean;
}

export interface EditBatchOperation {
  id: string;
  operation_index: number;
  operation_type: "find_replace" | "editor_replace";
  label?: string | null;
  replacement_text?: string | null;
  enabled: boolean;
  find_request?: FindReplaceSearchOptions | null;
  editor_request?: EditorOperationRequest | null;
  occurrences: EditBatchOccurrence[];
  occurrence_count: number;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface EditBatchPreview {
  batch_id: string;
  status: "ready" | "conflicted" | string;
  writes_performed: boolean;
  conflicts: Array<{
    code: string;
    message: string;
    operation_id?: string;
    conflicting_operation_id?: string;
    document_id?: string;
    occurrence_id?: string;
  }>;
  conflict_count: number;
  documents: Array<{
    document_id: string;
    document_name: string;
    base_version_id: string;
    find_replacement_count: number;
    editor_target_count: number;
    change_count: number;
    changes: Array<PreviewChange & {
      operation_id: string;
      operation_type: "find_replace" | "editor_replace";
      occurrence_id?: string;
      location?: Record<string, unknown>;
    }>;
  }>;
  affected_document_count: number;
  affected_location_count: number;
  timings: Record<string, number>;
}

export interface EditBatch {
  id: string;
  batch_id: string;
  document_set_id: string;
  title: string;
  status: string;
  stage: string;
  base_versions: Record<string, string>;
  operations: EditBatchOperation[];
  operation_count: number;
  enabled_operation_count: number;
  affected_document_ids: string[];
  affected_document_count: number;
  preview?: EditBatchPreview | null;
  error_detail?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  generation_status_url: string;
}
