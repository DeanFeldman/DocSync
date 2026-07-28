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
  element_type: "paragraph" | "heading" | "list_item" | "table_cell";
  text: string;
  style_name: string | null;
  table_index?: number;
  row_index?: number;
  column_index?: number;
}

export interface ViewerElement {
  id: string;
  document_id: string;
  paragraph_index: number;
  element_type: "paragraph" | "heading" | "list_item" | "table_cell";
  text: string;
  style_name: string | null;
  table_index?: number;
  row_index?: number;
  column_index?: number;
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
  pages: ViewerPage[];
  layout_regions?: LayoutElementRegion[];
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
  element_type: "paragraph" | "heading" | "list_item" | "table_cell";
  table_index?: number;
  row_index?: number;
  column_index?: number;
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

export type EditorElementType =
  | "paragraph"
  | "heading"
  | "list_item"
  | "table_cell"
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
  generation_id: string;
  status: string;
  download_url?: string;
  document_set?: DocumentSetResponse;
  versions?: DocumentVersion[];
  files?: Array<{
    source_document_id: string;
    version_id?: string;
    name: string;
    download_url?: string;
  }>;
}
