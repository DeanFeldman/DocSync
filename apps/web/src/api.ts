import type {
  CompareResponse,
  DocumentVersionsResponse,
  DocumentVersionRestoreResponse,
  DocumentView,
  DocumentSetLibraryResponse,
  DocumentSetResponse,
  EditorContentResponse,
  EditorGenerationResponse,
  EditorGenerationListResponse,
  EditBatch,
  EditBatchOperationInput,
  EditBatchPreview,
  EditorOperationRequest,
  EditorPreviewResponse,
  GenerationResponse,
  FindReplaceSearchOptions,
  FindReplaceSearchResponse,
  GlobalSearchResponse,
  MatchDecisionPayload,
  MatchDiscovery,
  PreviewResponse,
  PreviewRenderJobResponse,
  RenderMapResponse,
  SimilarMatchesResponse,
} from "./types";

const API_URL = (import.meta.env.VITE_API_URL ?? "/api").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }

  let message = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (Array.isArray(body.detail)) {
      message = body.detail
        .map((item) => {
          if (typeof item === "object" && item !== null && "msg" in item) {
            return String(item.msg);
          }
          return String(item);
        })
        .join(" ");
    }
  } catch {
    // Keep the HTTP status fallback when the body is not JSON.
  }
  throw new ApiError(message, response.status);
}

export async function fetchDocumentSets(): Promise<DocumentSetLibraryResponse> {
  const response = await fetch(`${API_URL}/document-sets`);
  return parseResponse<DocumentSetLibraryResponse>(response);
}

export async function fetchDocumentSet(
  documentSetId: string,
): Promise<DocumentSetResponse> {
  const response = await fetch(`${API_URL}/document-sets/${documentSetId}`);
  return parseResponse<DocumentSetResponse>(response);
}

export async function uploadDocumentSet(
  name: string,
  files: File[],
): Promise<DocumentSetResponse> {
  const form = new FormData();
  form.append("name", name);
  for (const file of files) {
    form.append("files", file);
  }

  const response = await fetch(`${API_URL}/document-sets`, {
    method: "POST",
    body: form,
  });
  return parseResponse<DocumentSetResponse>(response);
}


export async function addDocumentsToSet(
  documentSetId: string,
  files: File[],
): Promise<DocumentSetResponse> {
  const form = new FormData();
  for (const file of files) form.append("files", file);

  const response = await fetch(`${API_URL}/document-sets/${documentSetId}/documents`, {
    method: "POST",
    body: form,
  });
  return parseResponse<DocumentSetResponse>(response);
}

export async function removeDocumentFromSet(
  documentSetId: string,
  documentId: string,
): Promise<DocumentSetResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/documents/${documentId}`,
    { method: "DELETE" },
  );
  return parseResponse<DocumentSetResponse>(response);
}

export async function deleteDocumentSet(
  documentSetId: string,
): Promise<{ deleted_id: string; deleted: boolean }> {
  const response = await fetch(`${API_URL}/document-sets/${documentSetId}`, {
    method: "DELETE",
  });
  return parseResponse<{ deleted_id: string; deleted: boolean }>(response);
}

export async function searchDocumentSet(
  documentSetId: string,
  query: string,
  signal?: AbortSignal,
): Promise<GlobalSearchResponse> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/search?${params.toString()}`,
    { signal },
  );
  return parseResponse<GlobalSearchResponse>(response);
}

export async function previewEdit(
  documentSetId: string,
  linkGroupId: string,
  replacementText: string,
  sourceElementId?: string,
  includedElementIds?: string[],
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  const response = await fetch(`${API_URL}/document-sets/${documentSetId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      link_group_id: linkGroupId,
      replacement_text: replacementText,
      source_element_id: sourceElementId,
      included_element_ids: includedElementIds,
    }),
    signal,
  });
  return parseResponse<PreviewResponse>(response);
}

export async function generateEdit(
  documentSetId: string,
  linkGroupId: string,
  replacementText: string,
  sourceElementId?: string,
  includedElementIds?: string[],
  signal?: AbortSignal,
): Promise<GenerationResponse> {
  const response = await fetch(`${API_URL}/document-sets/${documentSetId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      link_group_id: linkGroupId,
      replacement_text: replacementText,
      source_element_id: sourceElementId,
      included_element_ids: includedElementIds,
    }),
    signal,
  });
  return parseResponse<GenerationResponse>(response);
}

export async function fetchDocumentView(
  versionId: string,
  signal?: AbortSignal,
): Promise<DocumentView> {
  // Open the lightweight structured preview immediately.
  // Microsoft Word rendering is intentionally not triggered during workspace loading.
  const response = await fetch(`${API_URL}/document-versions/${versionId}/pages`, {
    signal,
  });
  return parseResponse<DocumentView>(response);
}

export async function renderDocumentView(
  versionId: string,
  signal?: AbortSignal,
): Promise<DocumentView> {
  // Word rendering is an explicit, version-keyed user action.
  const response = await fetch(`${API_URL}/documents/${versionId}/render`, {
    method: "POST",
    signal,
  });
  return parseResponse<DocumentView>(response);
}

export async function createPreviewJob(
  versionId: string,
  signal?: AbortSignal,
): Promise<PreviewRenderJobResponse> {
  const response = await fetch(
    `${API_URL}/document-versions/${versionId}/preview-jobs`,
    { method: "POST", signal },
  );
  return parseResponse<PreviewRenderJobResponse>(response);
}

export async function fetchPreviewJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<PreviewRenderJobResponse> {
  const response = await fetch(`${API_URL}/preview-jobs/${jobId}`, { signal });
  return parseResponse<PreviewRenderJobResponse>(response);
}

export async function fetchWordPreview(
  versionId: string,
  signal?: AbortSignal,
): Promise<DocumentView> {
  const response = await fetch(
    `${API_URL}/document-versions/${versionId}/preview`,
    { signal },
  );
  return parseResponse<DocumentView>(response);
}

export async function fetchRenderMap(
  versionId: string,
  signal?: AbortSignal,
): Promise<RenderMapResponse> {
  const response = await fetch(
    `${API_URL}/document-versions/${versionId}/render-map`,
    { signal },
  );
  return parseResponse<RenderMapResponse>(response);
}

export async function fetchElementMatches(
  elementId: string,
  signal?: AbortSignal,
): Promise<MatchDiscovery> {
  const response = await fetch(`${API_URL}/document-elements/${elementId}/matches`, {
    signal,
  });
  return parseResponse<MatchDiscovery>(response);
}

export async function fetchEditorContent(
  versionId: string,
  signal?: AbortSignal,
): Promise<EditorContentResponse> {
  const response = await fetch(
    `${API_URL}/document-versions/${versionId}/editor-content`,
    { signal },
  );
  return parseResponse<EditorContentResponse>(response);
}

export async function fetchSimilarMatches(
  elementId: string,
  signal?: AbortSignal,
): Promise<SimilarMatchesResponse> {
  const response = await fetch(
    `${API_URL}/document-elements/${elementId}/similar-matches`,
    { signal },
  );
  return parseResponse<SimilarMatchesResponse>(response);
}

export async function compareDocumentElements(
  elementId: string,
  targetElementIds: string[],
  signal?: AbortSignal,
): Promise<CompareResponse> {
  const response = await fetch(
    `${API_URL}/document-elements/${elementId}/compare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate_element_ids: targetElementIds }),
      signal,
    },
  );
  return parseResponse<CompareResponse>(response);
}

export async function previewEditorEdit(
  documentSetId: string,
  request: EditorOperationRequest,
  signal?: AbortSignal,
): Promise<EditorPreviewResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/editor-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return parseResponse<EditorPreviewResponse>(response);
}

export async function generateEditorEdit(
  documentSetId: string,
  request: EditorOperationRequest,
  signal?: AbortSignal,
): Promise<EditorGenerationResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/editor-generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return parseResponse<EditorGenerationResponse>(response);
}

export async function queueEditorEdit(
  documentSetId: string,
  request: EditorOperationRequest,
  signal?: AbortSignal,
): Promise<EditorGenerationResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/editor-generate-async`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return parseResponse<EditorGenerationResponse>(response);
}

export async function fetchEditorGeneration(
  operationId: string,
  signal?: AbortSignal,
): Promise<EditorGenerationResponse> {
  const response = await fetch(
    `${API_URL}/generation-jobs/${operationId}`,
    { signal },
  );
  return parseResponse<EditorGenerationResponse>(response);
}

export async function findReplaceSearch(
  documentSetId: string,
  request: FindReplaceSearchOptions,
  signal?: AbortSignal,
): Promise<FindReplaceSearchResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/find-replace/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return parseResponse<FindReplaceSearchResponse>(response);
}

export async function fetchDraftEditBatch(
  documentSetId: string,
  signal?: AbortSignal,
): Promise<EditBatch | null> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/edit-batches/draft`,
    { signal },
  );
  const payload = await parseResponse<{ batch: EditBatch | null }>(response);
  return payload.batch;
}

export async function createEditBatch(
  documentSetId: string,
  title = "Pending changes",
  signal?: AbortSignal,
): Promise<EditBatch> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/edit-batches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
      signal,
    },
  );
  return parseResponse<EditBatch>(response);
}

export async function addEditBatchOperation(
  batchId: string,
  request: EditBatchOperationInput,
  signal?: AbortSignal,
): Promise<EditBatch> {
  const response = await fetch(`${API_URL}/edit-batches/${batchId}/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return parseResponse<EditBatch>(response);
}

export async function addEditorEditToPendingBatch(
  documentSetId: string,
  request: EditorOperationRequest,
  label?: string,
  signal?: AbortSignal,
): Promise<EditBatch> {
  const draft =
    (await fetchDraftEditBatch(documentSetId, signal)) ??
    (await createEditBatch(documentSetId, "Pending changes", signal));
  return addEditBatchOperation(
    draft.id,
    {
      operation_type: "editor_replace",
      label: label ?? "Reviewed editor replacement",
      editor_request: request,
      enabled: true,
    },
    signal,
  );
}

export async function updateEditBatchOperation(
  batchId: string,
  operationId: string,
  request: EditBatchOperationInput,
  signal?: AbortSignal,
): Promise<EditBatch> {
  const response = await fetch(
    `${API_URL}/edit-batches/${batchId}/operations/${operationId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return parseResponse<EditBatch>(response);
}

export async function removeEditBatchOperation(
  batchId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${API_URL}/edit-batches/${batchId}/operations/${operationId}`,
    { method: "DELETE", signal },
  );
  if (!response.ok) await parseResponse<never>(response);
}

export async function setEditBatchOccurrenceSelection(
  batchId: string,
  occurrenceRowId: string,
  selected: boolean,
  signal?: AbortSignal,
): Promise<EditBatch> {
  const response = await fetch(
    `${API_URL}/edit-batches/${batchId}/occurrences/${occurrenceRowId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected }),
      signal,
    },
  );
  return parseResponse<EditBatch>(response);
}

export async function clearEditBatch(
  batchId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_URL}/edit-batches/${batchId}`, {
    method: "DELETE",
    signal,
  });
  if (!response.ok) await parseResponse<never>(response);
}

export async function previewEditBatch(
  batchId: string,
  signal?: AbortSignal,
): Promise<EditBatchPreview> {
  const response = await fetch(`${API_URL}/edit-batches/${batchId}/preview`, {
    method: "POST",
    signal,
  });
  return parseResponse<EditBatchPreview>(response);
}

export async function generateEditBatch(
  batchId: string,
  signal?: AbortSignal,
): Promise<EditorGenerationResponse> {
  const response = await fetch(`${API_URL}/edit-batches/${batchId}/generate`, {
    method: "POST",
    signal,
  });
  return parseResponse<EditorGenerationResponse>(response);
}

export async function fetchEditorGenerationJobs(
  documentSetId: string,
  signal?: AbortSignal,
): Promise<EditorGenerationListResponse> {
  const response = await fetch(
    `${API_URL}/document-sets/${documentSetId}/generation-jobs`,
    { signal },
  );
  return parseResponse<EditorGenerationListResponse>(response);
}

export async function fetchDocumentVersions(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentVersionsResponse> {
  const response = await fetch(`${API_URL}/documents/${documentId}/versions`, {
    signal,
  });
  return parseResponse<DocumentVersionsResponse>(response);
}

export async function restoreDocumentVersion(
  documentId: string,
  versionId: string,
  expectedCurrentVersionId: string,
  signal?: AbortSignal,
): Promise<DocumentVersionRestoreResponse> {
  const response = await fetch(
    `${API_URL}/documents/${documentId}/versions/${versionId}/restore`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_current_version_id: expectedCurrentVersionId,
      }),
      signal,
    },
  );
  return parseResponse<DocumentVersionRestoreResponse>(response);
}

export async function saveMatchDecisions(
  sourceElementId: string,
  decisions: MatchDecisionPayload[],
  signal?: AbortSignal,
): Promise<{ saved: boolean; decisions: MatchDecisionPayload[] }> {
  const response = await fetch(
    `${API_URL}/document-elements/${sourceElementId}/match-decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
      signal,
    },
  );
  return parseResponse<{ saved: boolean; decisions: MatchDecisionPayload[] }>(
    response,
  );
}

export function versionDownloadUrl(versionId: string): string {
  return absoluteApiUrl(`/api/document-versions/${versionId}/download`);
}

export function currentDocumentDownloadUrl(documentId: string): string {
  return absoluteApiUrl(`/api/documents/${documentId}/download`);
}

export function absoluteDownloadUrl(relativeUrl: string): string {
  const apiOrigin = new URL(API_URL, window.location.origin);
  return new URL(relativeUrl, apiOrigin.origin).toString();
}

export function absoluteApiUrl(relativeUrl: string): string {
  const apiOrigin = new URL(API_URL, window.location.origin);
  return new URL(relativeUrl, apiOrigin.origin).toString();
}
