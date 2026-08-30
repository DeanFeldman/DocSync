import {
  UIEvent as ReactUIEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  absoluteApiUrl,
  addEditorEditToPendingBatch,
  removeEditorEditFromPendingBatch,
  ApiError,
  currentDocumentDownloadUrl,
  createPreviewJob,
  fetchDraftEditBatch,
  fetchDocumentVersions,
  fetchDocumentView,
  fetchEditorContent,
  fetchElementMatches,
  fetchSimilarMatches,
  fetchPreviewJob,
  fetchWordPreview,
  generateEdit,
  generateEditorEdit,
  previewEdit,
  previewEditorEdit,
  queueEditorEdit,
  restoreDocumentVersion,
  saveMatchDecisions,
  versionDownloadUrl,
} from "./api";
import {
  editorResourceKey,
  exactMatchesResourceKey,
  getWorkspaceResource,
  getWorkspaceViewState,
  loadWorkspaceResource,
  nearMatchesResourceKey,
  refreshWorkspaceResource,
  setWorkspaceResource,
  setWorkspaceViewState,
  versionHistoryResourceKey,
  wordPreviewResourceKey,
  workspaceViewStateKey,
  type WorkspaceMode,
} from "./workspaceResources";
import {
  candidateArrays,
  editorContentFromView,
  normaliseEditorContent,
  normaliseMatch,
  wordDifferenceSpans,
} from "./editorUtils";
import WordPreviewOverlay, {
  type LayoutSelectionIntent,
  type PendingLayoutOverride,
} from "./WordPreviewOverlay";
import type { InlineEditorCommand } from "./InlineLayoutEditor";
import { BATCH_UPDATED_EVENT } from "./FindReplacePanel";
import type {
  DifferenceSpan,
  DocumentSearchTarget,
  DocumentSetResponse,
  DocumentSummary,
  DocumentVersion,
  DocumentVersionsResponse,
  DocumentView,
  EditorBlock,
  EditorContentResponse,
  EditorEditMode,
  EditBatch,
  EditBatchOperation,
  EditorGenerationResponse,
  EditorMatch,
  EditorOperationRequest,
  EditorPreviewResponse,
  MatchDecision,
  MatchDiscovery,
  PreviewResponse,
  PreviewRenderJobResponse,
  QuillDraft,
} from "./types";

type LoadingStatus = "idle" | "loading" | "ready" | "error";
type EditorAction = "preview" | "generate" | "batch" | "restore" | null;
type WithoutCommandId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type InlineEditorCommandInput = WithoutCommandId<InlineEditorCommand>;

function pendingEditorOperationForBlock(
  batch: EditBatch | null,
  elementId: string,
): EditBatchOperation | null {
  return (
    batch?.operations.find(
      (operation) =>
        operation.enabled &&
        operation.operation_type === "editor_replace" &&
        operation.editor_request?.source_element_id === elementId,
    ) ?? null
  );
}

function pendingDraftForBlock(
  block: EditorBlock,
  batch: EditBatch | null,
): QuillDraft {
  const operation = pendingEditorOperationForBlock(batch, block.element_id);
  const target = operation?.editor_request?.targets.find(
    (candidate) => candidate.element_id === block.element_id);
  return {
    text: target?.replacement_text ?? block.text,
    delta: target?.delta ?? block.delta,
  };
}

function pendingFindReplacementForBlock(
  block: EditorBlock,
  batch: EditBatch | null,
  documentId: string | undefined,
  versionId: string | undefined,
): PendingLayoutOverride | null {
  if (!documentId || !versionId) return null;
  const replacements = (batch?.operations ?? []).flatMap((operation) =>
    operation.enabled && operation.operation_type === "find_replace"
      ? operation.occurrences
          .filter(
            (occurrence) =>
              occurrence.selected &&
              occurrence.document_id === documentId &&
              occurrence.base_version_id === versionId &&
              occurrence.element_id === block.element_id &&
              occurrence.segment_text === block.text,
          )
          .map((occurrence) => ({
            operationId: operation.id,
            start: occurrence.match_start,
            end: occurrence.match_end,
            before: occurrence.matched_text,
            after: operation.replacement_text ?? "",
          }))
      : [],
  );
  if (!replacements.length) return null;

  let replacementText = block.text;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    if (
      replacementText.slice(replacement.start, replacement.end) !== replacement.before
    ) {
      return null;
    }
    replacementText = `${replacementText.slice(0, replacement.start)}${replacement.after}${replacementText.slice(replacement.end)}`;
  }
  return {
    replacementText,
    operationId: replacements.map((replacement) => replacement.operationId).join(":"),
    locationCount: replacements.length,
    documentCount: 1,
  };
}

interface DocumentExperienceProps {
  documentSet: DocumentSetResponse;
  document: DocumentSummary | null;
  searchTarget: DocumentSearchTarget | null;
  onGenerated: (result: EditorGenerationResponse) => void;
  generationJobs: EditorGenerationResponse[];
  onGenerationQueued: (job: EditorGenerationResponse) => void;
  onDirtyChange: (dirty: boolean) => void;
}

function previewStageLabel(stage?: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    starting_microsoft_word: "Starting Microsoft Word",
    opening_document: "Opening document",
    rendering_pdf: "Rendering PDF",
    displaying_document: "Displaying document",
    updating_preview: "Updating preview",
    preparing_selectable_text: "Preparing selectable text",
    ready_to_edit: "Ready to edit",
    failed: "Failed",
  };
  return labels[stage ?? ""] ?? "Preparing Word preview";
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    [404, 405, 422, 501].includes(error.status)
  );
}

function isMissingFeature(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    [404, 405, 501].includes(error.status)
  );
}

function isMissingEndpoint(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (
      [405, 501].includes(error.status) ||
      (error.status === 404 && error.message === "Not Found")
    )
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function locationLabel(item: {
  element_type: string;
  paragraph_index: number;
  table_index?: number;
  row_index?: number;
  column_index?: number;
  section_index?: number;
  header_footer_type?: string;
}): string {
  if (
    ["header_paragraph", "footer_paragraph"].includes(item.element_type) &&
    item.section_index !== undefined
  ) {
    const region = item.element_type === "header_paragraph" ? "Header" : "Footer";
    const variant = item.header_footer_type?.startsWith("first_page")
      ? "First page"
      : item.header_footer_type?.startsWith("even_page")
        ? "Even pages"
        : "Default";
    return `${region} · Section ${item.section_index + 1} · ${variant} · Paragraph ${
      item.paragraph_index + 1
    }`;
  }
  if (
    ["table_cell", "table_paragraph"].includes(item.element_type) &&
    item.table_index !== undefined &&
    item.row_index !== undefined &&
    item.column_index !== undefined
  ) {
    return `Table ${item.table_index + 1} · Row ${item.row_index + 1} · Column ${
      item.column_index + 1
    }${
      item.element_type === "table_paragraph"
        ? ` · Paragraph ${item.paragraph_index + 1}`
        : ""
    }`;
  }
  return `${item.element_type.replaceAll("_", " ")} · block ${
    item.paragraph_index + 1
  }`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "Saved locally";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved locally";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function findLayoutElement(elementId: string): HTMLElement | null {
  return (
    Array.from(
      window.document.querySelectorAll<HTMLElement>(
        "[data-element-id]",
      ),
    ).find((element) => element.dataset.elementId === elementId) ?? null
  );
}

function DifferenceText({ spans }: { spans: DifferenceSpan[] }) {
  return (
    <span className="difference-text">
      {spans.map((span, index) => (
        <mark
          className={`difference-span ${span.kind}`}
          key={`${span.kind}-${index}`}
        >
          {span.text}
        </mark>
      ))}
    </span>
  );
}

function legacyPreview(
  response: PreviewResponse,
  editMode: EditorEditMode,
): EditorPreviewResponse {
  return {
    source_element_id: response.source_element_id ?? "",
    edit_mode: editMode,
    affected_document_count: response.affected_document_count,
    affected_location_count: response.affected_location_count,
    documents: response.documents,
    warnings: [
      "Compatibility preview: the local service used its exact-match editing endpoint.",
    ],
  };
}

function fallbackVersions(
  document: DocumentSummary,
  editorContent: EditorContentResponse | null,
): DocumentVersionsResponse {
  const currentVersionId =
    editorContent?.version_id ??
    document.current_version_id ??
    document.version_id;
  return {
    document_id: document.id,
    current_version_id: currentVersionId,
    versions: [
      {
        id: currentVersionId,
        document_id: document.id,
        version_number:
          editorContent?.version_number ?? document.version_number ?? 1,
        created_at: editorContent?.created_at ?? "",
        status: "current",
        is_current: true,
        download_url: document.download_url,
      },
    ],
  };
}

function normaliseVersions(
  response: DocumentVersionsResponse,
  document: DocumentSummary,
): DocumentVersionsResponse {
  const raw = response as unknown as Record<string, unknown>;
  const rawVersions = Array.isArray(raw.versions) ? raw.versions : [];
  const versions = rawVersions
    .map((value, index): DocumentVersion | null => {
      if (typeof value !== "object" || value === null) return null;
      const item = value as Record<string, unknown>;
      const id =
        (typeof item.id === "string" && item.id) ||
        (typeof item.version_id === "string" && item.version_id) ||
        "";
      if (!id) return null;
      return {
        id,
        document_id:
          typeof item.document_id === "string"
            ? item.document_id
            : document.id,
        version_number:
          typeof item.version_number === "number"
            ? item.version_number
            : index + 1,
        created_at:
          typeof item.created_at === "string" ? item.created_at : "",
        status: typeof item.status === "string" ? item.status : "completed",
        is_current: Boolean(item.is_current),
        parent_version_id:
          typeof item.parent_version_id === "string"
            ? item.parent_version_id
            : null,
        download_url:
          typeof item.download_url === "string"
            ? item.download_url
            : undefined,
        generation_id:
          typeof item.generation_id === "string"
            ? item.generation_id
            : null,
        operation_type:
          typeof item.operation_type === "string"
            ? item.operation_type
            : null,
        restored_from_version_id:
          typeof item.restored_from_version_id === "string"
            ? item.restored_from_version_id
            : null,
        restored_from_version_number:
          typeof item.restored_from_version_number === "number"
            ? item.restored_from_version_number
            : null,
      };
    })
    .filter((version): version is DocumentVersion => version !== null)
    .sort((left, right) => right.version_number - left.version_number);
  const currentVersionId =
    (typeof raw.current_version_id === "string" &&
      raw.current_version_id) ||
    versions.find((version) => version.is_current)?.id ||
    document.current_version_id ||
    document.version_id;
  return {
    document_id: document.id,
    current_version_id: currentVersionId,
    versions: versions.map((version) => ({
      ...version,
      is_current: version.id === currentVersionId,
    })),
  };
}

function PreviewDialog({
  preview,
  onClose,
  restoreFocus,
}: {
  preview: EditorPreviewResponse;
  onClose: () => void;
  restoreFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => restoreFocus.current?.focus());
    };
  }, [onClose, restoreFocus]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="preview-dialog editor-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-preview-title"
      >
        <header className="preview-dialog-header">
          <div>
            <p className="eyebrow">Preview only · no files created</p>
            <h2 id="editor-preview-title">Review every proposed change</h2>
            <p>
              {preview.affected_location_count} location
              {preview.affected_location_count === 1 ? "" : "s"} across{" "}
              {preview.affected_document_count} document
              {preview.affected_document_count === 1 ? "" : "s"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ×
          </button>
        </header>
        <div className="preview-dialog-body">
          {preview.warnings?.length ? (
            <div className="preview-warning" role="note">
              <strong>Check before generating</strong>
              <ul>
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.documents.map((document) => (
            <article
              className="preview-document"
              key={`${document.document_id}-${document.version_id ?? "current"}`}
            >
              <header>
                <span className="word-icon" aria-hidden="true">
                  W
                </span>
                <div>
                  <h3>{document.document_name}</h3>
                  <p>
                    {document.changes.length} targeted block
                    {document.changes.length === 1 ? "" : "s"}
                    {document.version_id
                      ? ` · Source version ${document.version_id.slice(0, 8)}`
                      : ""}
                    {` · ${preview.edit_mode.replaceAll("_", " ")}`}
                  </p>
                </div>
              </header>
              {document.changes.map((change) => (
                <div className="diff" key={change.element_id}>
                  <p className="location-label">{locationLabel(change)}</p>
                  {change.linked_sections && change.linked_sections.length > 1 && (
                    <p className="preview-linked-sections">
                      Linked sections: {change.linked_sections
                        .map((sectionIndex) => sectionIndex + 1)
                        .join(", ")}
                    </p>
                  )}
                  <div className="diff-grid">
                    <div className="diff-side before">
                      <span>Before</span>
                      <p>{change.before}</p>
                    </div>
                    <div className="diff-arrow" aria-hidden="true">
                      →
                    </div>
                    <div className="diff-side after">
                      <span>After</span>
                      <p>{change.after}</p>
                    </div>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
        <footer className="preview-dialog-footer">
          <div>
            <strong>Preview complete</strong>
            <span>
              Close this preview, then use the separate Generate action when
              you are satisfied.
            </span>
          </div>
          <div>
            <button type="button" className="primary-button" onClick={onClose}>
              Back to editor
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export default function DocumentExperience({
  documentSet,
  document,
  searchTarget,
  onGenerated,
  generationJobs,
  onGenerationQueued,
  onDirtyChange,
}: DocumentExperienceProps) {
  const activeVersionId =
    document?.current_version_id ?? document?.version_id ?? "";
  const versionScope = useMemo(
    () =>
      documentSet.documents
        .map(
          (item) =>
            `${item.id}:${item.current_version_id ?? item.version_id}`,
        )
        .sort()
        .join(","),
    [documentSet.documents],
  );
  const activeViewStateKey =
    document && activeVersionId
      ? workspaceViewStateKey(documentSet.id, document.id, activeVersionId)
      : "";
  const [mode, setMode] = useState<WorkspaceMode>("layout");
  const [editorContent, setEditorContent] =
    useState<EditorContentResponse | null>(null);
  const [contentStatus, setContentStatus] =
    useState<LoadingStatus>("idle");
  const [layoutView, setLayoutView] = useState<DocumentView | null>(null);
  const [layoutStatus, setLayoutStatus] =
    useState<LoadingStatus>("idle");
  const [previewJob, setPreviewJob] =
    useState<PreviewRenderJobResponse | null>(null);
  const [inlineSelection, setInlineSelection] =
    useState<LayoutSelectionIntent | null>(null);
  const [inlineCommand, setInlineCommand] =
    useState<InlineEditorCommand | null>(null);
  const [selectedElementId, setSelectedElementId] = useState("");
  const [draft, setDraft] = useState<QuillDraft | null>(null);
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [matches, setMatches] = useState<EditorMatch[]>([]);
  const [matchStatus, setMatchStatus] =
    useState<LoadingStatus>("idle");
  const [nearMatchStatus, setNearMatchStatus] =
    useState<LoadingStatus>("idle");
  const [legacyDiscovery, setLegacyDiscovery] =
    useState<MatchDiscovery | null>(null);
  const [includedElementIds, setIncludedElementIds] = useState<Set<string>>(
    new Set(),
  );
  const [editMode, setEditMode] = useState<EditorEditMode>("shared");
  const [targetReplacements, setTargetReplacements] = useState<
    Record<string, string>
  >({});
  const [preview, setPreview] = useState<EditorPreviewResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSignature, setPreviewSignature] = useState("");
  const [batchAddedSignature, setBatchAddedSignature] = useState("");
  const [pendingBatch, setPendingBatch] = useState<EditBatch | null>(null);
  const [stagingStatus, setStagingStatus] = useState<"idle" | "editing" | "saving" | "saved" | "error">("idle");
  const [action, setAction] = useState<EditorAction>(null);
  const [localError, setLocalError] = useState("");
  const [versions, setVersions] =
    useState<DocumentVersionsResponse | null>(null);
  const [versionStatus, setVersionStatus] =
    useState<LoadingStatus>("idle");
  const [historyRequested, setHistoryRequested] = useState(false);
  const [versionApiAvailable, setVersionApiAvailable] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState("");
  const [restoreNotice, setRestoreNotice] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [lastGeneration, setLastGeneration] =
    useState<EditorGenerationResponse | null>(null);
  const [pendingGenerationId, setPendingGenerationId] = useState("");
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const versionHistoryRef = useRef<HTMLDetailsElement>(null);
  const modeScrollRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<WorkspaceMode>(mode);
  const mountedRef = useRef(false);
  const activeDocumentIdRef = useRef(document?.id ?? "");
  const documentContextRef = useRef({
    documentId: document?.id ?? "",
    token: 0,
  });
  const contentRequestRef = useRef(0);
  const layoutRequestRef = useRef(0);
  const layoutAbortRef = useRef<AbortController | null>(null);
  const layoutViewRef = useRef<DocumentView | null>(null);
  const previewVersionStartedRef = useRef("");
  const documentOpenStartedRef = useRef(performance.now());
  const previewRenderLoggedRef = useRef("");
  const inlineCommandIdRef = useRef(0);
  const matchRequestRef = useRef(0);
  const editorActionRequestRef = useRef(0);
  const editorActionAbortRef = useRef<AbortController | null>(null);
  const generationSubmissionRef = useRef(false);
  const generationStartedAtRef = useRef(new Map<string, number>());
  const draftTouchedRef = useRef(false);
  const queuedGenerationSnapshotRef = useRef<{
    jobId: string;
    documentId: string;
    content: EditorContentResponse | null;
  } | null>(null);
  activeDocumentIdRef.current = document?.id ?? "";
  if (documentContextRef.current.documentId !== activeDocumentIdRef.current) {
    documentContextRef.current = {
      documentId: activeDocumentIdRef.current,
      token: documentContextRef.current.token + 1,
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      documentContextRef.current.token += 1;
      editorActionRequestRef.current += 1;
      editorActionAbortRef.current?.abort();
      editorActionAbortRef.current = null;
      layoutAbortRef.current?.abort();
      layoutAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pendingGenerationId) return;
    const job = generationJobs.find(
      (candidate) => candidate.generation_id === pendingGenerationId,
    );
    if (!job) return;
    setLastGeneration(job);
    if (["queued", "processing"].includes(job.status)) return;

    const generationStartedAt = generationStartedAtRef.current.get(
      job.generation_id,
    );
    if (generationStartedAt !== undefined) {
      window.requestAnimationFrame(() => {
        console.info("DocuSync generation ready", {
          generationId: job.generation_id,
          status: job.status,
          totalMs: Math.round(performance.now() - generationStartedAt),
          serverTimings: job.timings,
        });
      });
      generationStartedAtRef.current.delete(job.generation_id);
    }

    setPendingGenerationId("");
    const snapshot = queuedGenerationSnapshotRef.current;
    queuedGenerationSnapshotRef.current = null;
    if (
      ["failed", "interrupted"].includes(job.status) &&
      snapshot?.jobId === job.generation_id &&
      documentContextRef.current.documentId === snapshot.documentId
    ) {
      setEditorContent(snapshot.content);
      setRefreshToken((current) => current + 1);
      setLocalError(
        job.error_detail ??
          job.error ??
          "Processing failed. No document versions were changed.",
      );
    }
  }, [generationJobs, pendingGenerationId]);

  const selectedBlock = useMemo(
    () =>
      editorContent?.blocks.find(
        (block) => block.element_id === selectedElementId,
      ) ?? null,
    [editorContent, selectedElementId],
  );
  const pendingEditorOperation = useMemo(
    () =>
      selectedBlock
        ? pendingEditorOperationForBlock(pendingBatch, selectedBlock.element_id)
        : null,
    [pendingBatch, selectedBlock],
  );
  const pendingDraft = useMemo(
    () =>
      selectedBlock ? pendingDraftForBlock(selectedBlock, pendingBatch) : null,
    [pendingBatch, selectedBlock],
  );
  const pendingLayoutOverridesByElementId = useMemo(() => {
    const overrides: Record<string, PendingLayoutOverride> = {};
    for (const operation of pendingBatch?.operations ?? []) {
      if (!operation.enabled || operation.operation_type !== "editor_replace" || !operation.editor_request) continue;
      const locationCount = operation.occurrence_count || operation.editor_request.targets.length;
      const documentCount = operation.document_count || Object.keys(operation.editor_request.base_versions).length;
      for (const target of operation.editor_request.targets) {
        overrides[target.element_id] = {
          replacementText: target.replacement_text,
          operationId: operation.id,
          locationCount,
          documentCount,
        };
      }
    }
    for (const block of editorContent?.blocks ?? []) {
      if (overrides[block.element_id]) continue;
      const replacement = pendingFindReplacementForBlock(
        block,
        pendingBatch,
        document?.id,
        activeVersionId,
      );
      if (replacement) overrides[block.element_id] = replacement;
    }
    return overrides;
  }, [activeVersionId, document?.id, editorContent?.blocks, pendingBatch]);
  const sourceMatch = useMemo(
    () =>
      matches.find((match) => match.element_id === selectedElementId) ?? null,
    [matches, selectedElementId],
  );

  const dirty = useMemo(() => {
    if (!pendingDraft || !draft) return false;
    if (draft.text !== pendingDraft.text) return true;
    return JSON.stringify(draft.delta) !== JSON.stringify(pendingDraft.delta);
  }, [draft, pendingDraft]);

  const perDocumentDirty = useMemo(
    () =>
      matches.some(
        (match) =>
          includedElementIds.has(match.element_id) &&
          (targetReplacements[match.element_id] ?? match.text) !== match.text,
      ),
    [includedElementIds, matches, targetReplacements],
  );
  const sourceDiffersFromBase = useMemo(() => {
    if (!selectedBlock || !draft) return false;
    if (draft.text !== selectedBlock.text) return true;
    return JSON.stringify(draft.delta) !== JSON.stringify(selectedBlock.delta);
  }, [draft, selectedBlock]);

  useEffect(() => {
    let active = true;
    const refreshPendingBatch = () => {
      void fetchDraftEditBatch(documentSet.id)
        .then((batch) => {
          if (active) setPendingBatch(batch);
        })
        .catch((error) => {
          if (active && !isMissingFeature(error)) {
            setLocalError(errorMessage(error, "Pending Changes could not be refreshed."));
          }
        });
    };
    refreshPendingBatch();
    window.addEventListener(BATCH_UPDATED_EVENT, refreshPendingBatch);
    return () => {
      active = false;
      window.removeEventListener(BATCH_UPDATED_EVENT, refreshPendingBatch);
    };
  }, [documentSet.id]);

  useEffect(() => {
    if (!selectedBlock || !pendingDraft || draftTouchedRef.current) return;
    setDraft(pendingDraft);
    setStagingStatus(pendingEditorOperation ? "saved" : "idle");
  }, [pendingDraft, pendingEditorOperation, selectedBlock]);

  useEffect(() => {
    onDirtyChange(false);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange, perDocumentDirty]);

  useEffect(() => {
    setRestoreNotice("");
    setRestoreError("");
    setRestoringVersionId("");
    setLocalError("");
    setHistoryRequested(false);
    setVersions(null);
    setVersionStatus("idle");
    setNearMatchStatus("idle");

    const savedState = activeViewStateKey
      ? getWorkspaceViewState(activeViewStateKey)
      : undefined;
    const nextMode: WorkspaceMode = "layout";
    setMode(nextMode);
    modeRef.current = nextMode;
    setSelectedElementId(savedState?.selectedElementId ?? "");
    setDraft(savedState?.draft ?? null);
    setInlineSelection(null);
    setInlineCommand(null);
    setPreviewJob(null);
    documentOpenStartedRef.current = performance.now();
    previewRenderLoggedRef.current = "";
    layoutAbortRef.current?.abort();
    layoutAbortRef.current = null;

    if (document && activeVersionId) {
      const cachedPreview = getWorkspaceResource<DocumentView>(
        wordPreviewResourceKey(
          documentSet.id,
          document.id,
          activeVersionId,
        ),
      );
      layoutViewRef.current = cachedPreview ?? null;
      setLayoutView(cachedPreview ?? null);
      setLayoutStatus(cachedPreview ? "ready" : "idle");
    } else {
      layoutViewRef.current = null;
      setLayoutView(null);
      setLayoutStatus("idle");
    }
  }, [activeViewStateKey, activeVersionId, document?.id, documentSet.id]);

  useEffect(() => {
    setPendingGenerationId("");
    queuedGenerationSnapshotRef.current = null;
  }, [document?.id]);

  useEffect(() => {
    if (!document) {
      setEditorContent(null);
      setContentStatus("idle");
      return;
    }

    const requestId = ++contentRequestRef.current;
    const requestedVersionId =
      document.current_version_id ?? document.version_id;
    const resourceKey = editorResourceKey(
      documentSet.id,
      document.id,
      requestedVersionId,
    );
    const cachedContent = getWorkspaceResource<EditorContentResponse>(
      resourceKey,
    );
    setContentStatus(cachedContent ? "ready" : "loading");
    setEditorContent(cachedContent ?? null);
    setMatches([]);
    setMatchStatus("idle");
    setNearMatchStatus("idle");
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    setLastGeneration(null);

    async function loadContent() {
      let loaded = false;
      const fetchStarted = performance.now();
      const cacheHit = Boolean(cachedContent);
      try {
        const response = await loadWorkspaceResource(
          resourceKey,
          async () => {
            try {
              const content = await fetchEditorContent(requestedVersionId);
              return normaliseEditorContent(content, document!);
            } catch (error) {
              if (!isUnavailable(error)) throw error;
              const compatibleView = await fetchDocumentView(requestedVersionId);
              return editorContentFromView(compatibleView, document!);
            }
          },
        );
        if (requestId !== contentRequestRef.current) return;
        setEditorContent(response);
        const savedState = activeViewStateKey
          ? getWorkspaceViewState(activeViewStateKey)
          : undefined;
        const restoredElementId =
          savedState?.selectedElementId &&
          response.blocks.some(
            (block) => block.element_id === savedState.selectedElementId,
          )
            ? savedState.selectedElementId
            : "";
        setSelectedElementId(restoredElementId);
        setDraft(restoredElementId ? savedState?.draft ?? null : null);
        loaded = true;
      } catch (error) {
        if (requestId !== contentRequestRef.current) return;
        setLocalError(
          `${document!.name}: ${errorMessage(
            error,
            "The structured editor could not open.",
          )}`,
        );
      } finally {
        console.info("docsync.document_fetch_timing", {
          version_id: requestedVersionId,
          cache_hit: cacheHit,
          duration_ms: Number((performance.now() - fetchStarted).toFixed(2)),
        });
        if (requestId === contentRequestRef.current) {
          setContentStatus(loaded ? "ready" : "error");
        }
      }
    }

    void loadContent();
  }, [
    activeViewStateKey,
    document?.id,
    document?.version_id,
    document?.current_version_id,
    documentSet.id,
    refreshToken,
  ]);

  useEffect(() => {
    if (!editorContent || layoutViewRef.current) return;
    const logKey = `structured:${editorContent.version_id}`;
    if (previewRenderLoggedRef.current === logKey) return;
    previewRenderLoggedRef.current = logKey;
    const frame = window.requestAnimationFrame(() => {
      console.info("docsync.preview_render_timing", {
        version_id: editorContent.version_id,
        mode: "structured_text",
        duration_ms: Number(
          (performance.now() - documentOpenStartedRef.current).toFixed(2),
        ),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorContent?.version_id]);

  useEffect(() => {
    if (
      !searchTarget ||
      !document ||
      searchTarget.document_id !== document.id ||
      contentStatus !== "ready" ||
      !editorContent
    ) {
      return;
    }

    selectElementById(searchTarget.element_id, {
      skipDiscardConfirmation: true,
      sourceLabel: "search result",
      remainInLayout: true,
    });
  }, [
    contentStatus,
    document?.id,
    editorContent?.version_id,
    searchTarget?.request_id,
  ]);

  useLayoutEffect(() => {
    if (
      !searchTarget ||
      searchTarget.element_id !== selectedElementId ||
      mode !== "layout"
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const target = findLayoutElement(searchTarget.element_id);
      if (!target) return;

      target.scrollIntoView({ behavior: "auto", block: "center" });
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    editorContent?.version_id,
    mode,
    searchTarget?.request_id,
    selectedElementId,
  ]);

  useEffect(() => {
    if (
      !activeViewStateKey ||
      editorContent?.version_id !== activeVersionId
    ) {
      return;
    }
    const existing = getWorkspaceViewState(activeViewStateKey);
    setWorkspaceViewState(activeViewStateKey, {
      mode,
      selectedElementId,
      draft,
      scrollTop: existing?.scrollTop ?? {
        layout: 0,
        edit: 0,
        compare: 0,
      },
    });
  }, [
    activeVersionId,
    activeViewStateKey,
    draft,
    editorContent?.version_id,
    mode,
    selectedElementId,
  ]);

  useLayoutEffect(() => {
    if (!activeViewStateKey || contentStatus !== "ready") return;
    const savedState = getWorkspaceViewState(activeViewStateKey);
    const frame = window.requestAnimationFrame(() => {
      if (modeScrollRef.current) {
        modeScrollRef.current.scrollTop =
          savedState?.scrollTop[mode] ?? 0;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeViewStateKey, contentStatus, mode]);

  useEffect(() => {
    if (!document || !historyRequested) {
      if (!document) {
        setVersions(null);
        setVersionStatus("idle");
      }
      return;
    }
    const expectedVersionId =
      document.current_version_id ?? document.version_id;
    const resourceKey = versionHistoryResourceKey(
      documentSet.id,
      document.id,
      expectedVersionId,
    );
    const cachedVersions =
      getWorkspaceResource<DocumentVersionsResponse>(resourceKey);
    if (cachedVersions) {
      setVersions(cachedVersions);
      setVersionStatus("ready");
      setVersionApiAvailable(true);
      return;
    }

    const requestId = documentContextRef.current.token;
    setVersionStatus("loading");

    async function loadVersions() {
      let finalStatus: LoadingStatus = "ready";
      try {
        const response = await loadWorkspaceResource(
          resourceKey,
          async () =>
            normaliseVersions(
              await fetchDocumentVersions(document!.id),
              document!,
            ),
        );
        if (
          requestId !== documentContextRef.current.token ||
          activeDocumentIdRef.current !== document!.id
        ) {
          return;
        }
        setVersions(response);
        setVersionApiAvailable(true);
      } catch (error) {
        if (
          requestId !== documentContextRef.current.token ||
          activeDocumentIdRef.current !== document!.id
        ) {
          return;
        }
        setVersions(fallbackVersions(document!, editorContent));
        setVersionApiAvailable(false);
        finalStatus = isMissingFeature(error) ? "ready" : "error";
      } finally {
        if (
          requestId === documentContextRef.current.token &&
          activeDocumentIdRef.current === document!.id
        ) {
          setVersionStatus(finalStatus);
        }
      }
    }

    void loadVersions();
  }, [
    document?.id,
    document?.version_id,
    document?.current_version_id,
    documentSet.id,
    editorContent?.version_id,
    historyRequested,
    refreshToken,
  ]);

  useEffect(() => {
    if (!selectedBlock || !selectedBlock.supported || selectedBlock.read_only) {
      setMatches([]);
      setMatchStatus("idle");
      setNearMatchStatus("idle");
      setLegacyDiscovery(null);
      return;
    }

    const requestId = ++matchRequestRef.current;
    const controller = new AbortController();
    const loadNearMatches = true;
    setMatchStatus("loading");
    setNearMatchStatus(loadNearMatches ? "loading" : "idle");
    setMatches([]);
    setLegacyDiscovery(null);

    async function loadMatches() {
      try {
        const exactResourceKey = exactMatchesResourceKey(
          documentSet.id,
          selectedBlock!.document_id,
          versionScope,
          selectedBlock!.element_id,
        );
        const nearResourceKey = nearMatchesResourceKey(
          documentSet.id,
          selectedBlock!.document_id,
          versionScope,
          selectedBlock!.element_id,
        );
        const [exactResult, similarResult] = await Promise.allSettled([
          loadWorkspaceResource(
            exactResourceKey,
            () => fetchElementMatches(selectedBlock!.element_id),
          ),
          loadNearMatches
            ? loadWorkspaceResource(
                nearResourceKey,
                () => fetchSimilarMatches(selectedBlock!.element_id),
              )
            : Promise.reject(new ApiError("Near matching is deferred.", 404)),
        ]);
        if (
          controller.signal.aborted ||
          requestId !== matchRequestRef.current
        ) {
          return;
        }

        const source: EditorMatch = {
          element_id: selectedBlock!.element_id,
          document_id: selectedBlock!.document_id,
          document_name: document?.name ?? "Current document",
          version_id: selectedBlock!.version_id,
          paragraph_index: selectedBlock!.paragraph_index,
          element_type: selectedBlock!.element_type,
          text: selectedBlock!.text,
          style_name: selectedBlock!.style_name,
          match_type: "source",
          similarity_score: 1,
          decision: "confirmed",
          difference_spans: [
            { text: selectedBlock!.text, kind: "shared" },
          ],
          table_index: selectedBlock!.table_index,
          row_index: selectedBlock!.row_index,
          column_index: selectedBlock!.column_index,
        };
        const byId = new Map<string, EditorMatch>([
          [source.element_id, source],
        ]);

      if (exactResult.status === "fulfilled") {
        setLegacyDiscovery(exactResult.value);
        const exactCandidates =
          exactResult.value.exact_matches ??
          exactResult.value.link_group?.members ??
          [];
        for (const member of exactCandidates) {
          const match = normaliseMatch(
            member,
            selectedBlock!.text,
            "exact",
          );
          if (
            match &&
            match.element_id !== selectedBlock!.element_id &&
            match.element_type === selectedBlock!.element_type
          ) {
            match.difference_spans = [
              { text: match.text, kind: "shared" },
            ];
            byId.set(match.element_id, match);
          }
        }
      } else if (!isMissingFeature(exactResult.reason)) {
        setLocalError(
          `${document?.name ?? "Document"} · ${locationLabel(
            selectedBlock!,
          )}: ${errorMessage(
            exactResult.reason,
            "Exact matches could not be loaded.",
          )}`,
        );
      }

      if (similarResult.status === "fulfilled") {
        for (const item of candidateArrays(similarResult.value)) {
          const match = normaliseMatch(
            item,
            selectedBlock!.text,
            "near",
          );
          if (match && !byId.has(match.element_id)) {
            byId.set(match.element_id, match);
          }
        }
      } else if (!isMissingFeature(similarResult.reason)) {
        setLocalError(
          `${document?.name ?? "Document"} · ${locationLabel(
            selectedBlock!,
          )}: ${errorMessage(
            similarResult.reason,
            "Near matches could not be loaded.",
          )}`,
        );
      }

      let nextMatches = Array.from(byId.values());
      const candidateIds = nextMatches
        .filter((match) => match.match_type !== "source")
        .map((match) => match.element_id);
      if (candidateIds.length > 0) {
        try {
          // The near-match endpoint already returns the final score, decision,
          // and difference spans. No second comparison request is necessary.
          const comparison = { items: [] as EditorMatch[] };
          if (
            controller.signal.aborted ||
            requestId !== matchRequestRef.current
          ) {
            return;
          }
          const comparisonById = new Map<string, EditorMatch>();
          for (const item of candidateArrays(comparison)) {
            const match = normaliseMatch(
              item,
              selectedBlock!.text,
              "near",
            );
            if (match) comparisonById.set(match.element_id, match);
          }
          nextMatches = nextMatches.map((match) => {
            const compared = comparisonById.get(match.element_id);
            return compared
              ? {
                  ...match,
                  similarity_score: compared.similarity_score,
                  decision:
                    match.match_type === "exact"
                      ? "confirmed"
                      : compared.decision,
                  difference_spans: compared.difference_spans,
                }
              : match;
          });
        } catch (error) {
          if (!isMissingFeature(error) && !controller.signal.aborted) {
            setLocalError(
              `${document?.name ?? "Document"} · ${locationLabel(
                selectedBlock!,
              )}: ${errorMessage(
                error,
                "Comparison details could not be loaded.",
              )}`,
            );
          }
        }
      }

      if (
        controller.signal.aborted ||
        requestId !== matchRequestRef.current
      ) {
        return;
      }
      nextMatches = nextMatches.map((match) => ({
        ...match,
        difference_spans:
          match.difference_spans.length > 0
            ? match.difference_spans
            : wordDifferenceSpans(selectedBlock!.text, match.text),
      }));
      setMatches(nextMatches);
      const stagedRequest = pendingEditorOperationForBlock(
        pendingBatch,
        selectedBlock!.element_id,
      )?.editor_request;
      setIncludedElementIds(
        new Set(
          stagedRequest?.targets.map((target) => target.element_id) ??
            nextMatches
              .filter(
                (match) =>
                  match.match_type === "source" ||
                  match.match_type === "exact",
              )
              .map((match) => match.element_id),
        ),
      );
      setTargetReplacements(
        Object.fromEntries(
          nextMatches.map((match) => {
            const stagedTarget = stagedRequest?.targets.find(
              (target) => target.element_id === match.element_id,
            );
            return [match.element_id, stagedTarget?.replacement_text ?? match.text];
          }),
        ),
      );
      if (stagedRequest) setEditMode(stagedRequest.edit_mode);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          requestId === matchRequestRef.current
        ) {
          if (loadNearMatches) setNearMatchStatus("error");
          setLocalError(
            `${document?.name ?? "Document"} · ${locationLabel(
              selectedBlock!,
            )}: ${errorMessage(
              error,
              "Related blocks could not be loaded.",
            )}`,
          );
        }
      } finally {
        if (
          !controller.signal.aborted &&
          requestId === matchRequestRef.current
        ) {
          setMatchStatus("ready");
          if (loadNearMatches) {
            setNearMatchStatus((current) =>
              current === "loading" ? "ready" : current,
            );
          }
        }
      }
    }

    // DOCSYNC_MATCH_REQUEST_FINALLY_V2
    void loadMatches()
      .catch((error) => {
        if (
          controller.signal.aborted ||
          requestId !== matchRequestRef.current
        ) {
          return;
        }

        setMatchStatus("error");
        setLocalError(
          `${document?.name ?? "Document"} · ${locationLabel(
            selectedBlock!,
          )}: ${errorMessage(
            error,
            "Related blocks could not be loaded.",
          )}`,
        );
      })
      .finally(() => {
        if (
          controller.signal.aborted ||
          requestId !== matchRequestRef.current
        ) {
          return;
        }

        setMatchStatus((current) =>
          current === "loading" ? "ready" : current,
        );
        if (loadNearMatches) {
          setNearMatchStatus((current) =>
            current === "loading" ? "ready" : current,
          );
        }
      });
    return () => controller.abort();
  }, [
    document?.name,
    documentSet.id,
    mode,
    pendingBatch,
    selectedBlock?.element_id,
    versionScope,
  ]);

  async function loadWordPreview(force = false) {
    if (!document || !activeVersionId) return;
    if (layoutAbortRef.current && !force) return;
    layoutAbortRef.current?.abort();
    const controller = new AbortController();
    layoutAbortRef.current = controller;
    const requestId = ++layoutRequestRef.current;
    const resourceKey = wordPreviewResourceKey(
      documentSet.id,
      document.id,
      activeVersionId,
    );
    setLayoutStatus("loading");
    setPreviewJob(null);
    setLocalError("");

    const displayPreview = (response: DocumentView) => {
      if (
        controller.signal.aborted ||
        response.version_id !== activeVersionId ||
        requestId !== layoutRequestRef.current
      ) {
        return;
      }
      layoutViewRef.current = response;
      setWorkspaceResource(resourceKey, response);
      setLayoutView(response);
      const renderStarted = performance.now();
      window.requestAnimationFrame(() => {
        console.info("docsync.preview_render_timing", {
          version_id: activeVersionId,
          mode: response.preview_cache_status === "stale" ? "stale_word_cache" : "word_cache",
          duration_ms: Number((performance.now() - renderStarted).toFixed(2)),
          opening_duration_ms: Number(
            (performance.now() - documentOpenStartedRef.current).toFixed(2),
          ),
        });
      });
    };

    try {
      const fetchStarted = performance.now();
      let job = await createPreviewJob(activeVersionId, controller.signal);
      console.info("docsync.document_fetch_timing", {
        version_id: activeVersionId,
        resource: "preview_job",
        duration_ms: Number((performance.now() - fetchStarted).toFixed(2)),
      });
      let displayed = Boolean(layoutViewRef.current);
      let displayedFresh = Boolean(
        displayed && layoutViewRef.current?.preview_cache_status !== "stale",
      );
      if (job.cached_preview) {
        displayPreview(job.cached_preview);
        displayed = true;
        displayedFresh = !job.stale_preview_available;
      }
      while (!controller.signal.aborted) {
        if (
          requestId !== layoutRequestRef.current ||
          activeDocumentIdRef.current !== document.id
        ) return;
        setPreviewJob(job);
        if (job.pdf_ready && !displayed) {
          const response = await refreshWorkspaceResource(
            resourceKey,
            () => fetchWordPreview(activeVersionId),
          );
          if (controller.signal.aborted) return;
          displayPreview(response);
          displayed = true;
          displayedFresh = true;
        }
        if (["completed", "failed", "interrupted"].includes(job.status)) {
          if (job.status === "completed" && !displayedFresh) {
            const response = await refreshWorkspaceResource(
              resourceKey,
              () => fetchWordPreview(activeVersionId),
            );
            if (controller.signal.aborted) return;
            displayPreview(response);
            displayed = true;
            displayedFresh = true;
          } else if (job.status !== "completed") {
            throw new Error(
              job.error ?? "Microsoft Word could not prepare the preview.",
            );
          }
          break;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, 350);
          controller.signal.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
        job = await fetchPreviewJob(job.job_id, controller.signal);
      }
      if (!controller.signal.aborted) {
        setLayoutStatus("ready");
        console.info("docsync.document_ready_timing", {
          version_id: activeVersionId,
          duration_ms: Number(
            (performance.now() - documentOpenStartedRef.current).toFixed(2),
          ),
          cache_status: layoutViewRef.current?.preview_cache_status ?? "none",
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        requestId !== layoutRequestRef.current ||
        activeDocumentIdRef.current !== document.id
      ) {
        return;
      }
      const retainedPreview = layoutViewRef.current;
      setLayoutStatus(retainedPreview ? "ready" : "error");
      setLocalError(
        `${document.name}: ${errorMessage(
          error,
          retainedPreview
            ? "The preview refresh failed. The last working cached preview remains available."
            : "Microsoft Word could not prepare the preview. Close any open Word dialogue and retry.",
        )}`,
      );
    } finally {
      if (layoutAbortRef.current === controller) {
        layoutAbortRef.current = null;
      }
    }
  }

  useEffect(() => {
    if (
      mode !== "layout" ||
      !document ||
      !activeVersionId ||
      previewVersionStartedRef.current === activeVersionId
    ) {
      return;
    }
    previewVersionStartedRef.current = activeVersionId;
    void loadWordPreview();
  }, [activeVersionId, document?.id, mode]);

  function setWorkspaceMode(nextMode: WorkspaceMode) {
    const currentMode = modeRef.current;
    if (activeViewStateKey) {
      const existing = getWorkspaceViewState(activeViewStateKey);
      setWorkspaceViewState(activeViewStateKey, {
        mode: nextMode,
        selectedElementId,
        draft,
        scrollTop: {
          layout:
            currentMode === "layout"
              ? modeScrollRef.current?.scrollTop ?? 0
              : existing?.scrollTop.layout ?? 0,
          edit:
            currentMode === "edit"
              ? modeScrollRef.current?.scrollTop ?? 0
              : existing?.scrollTop.edit ?? 0,
          compare:
            currentMode === "compare"
              ? modeScrollRef.current?.scrollTop ?? 0
              : existing?.scrollTop.compare ?? 0,
        },
      });
    }
    modeRef.current = nextMode;
    setMode(nextMode);
    window.requestAnimationFrame(() => {
      const savedState = activeViewStateKey
        ? getWorkspaceViewState(activeViewStateKey)
        : undefined;
      if (modeScrollRef.current) {
        modeScrollRef.current.scrollTop =
          savedState?.scrollTop[nextMode] ?? 0;
      }
    });
  }



  function handleModeScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (activeViewStateKey) {
      const existing = getWorkspaceViewState(activeViewStateKey);
      setWorkspaceViewState(activeViewStateKey, {
        mode,
        selectedElementId,
        draft,
        scrollTop: {
          layout: existing?.scrollTop.layout ?? 0,
          edit: existing?.scrollTop.edit ?? 0,
          compare: existing?.scrollTop.compare ?? 0,
          [mode]: event.currentTarget.scrollTop,
        },
      });
    }

  }



  function selectElementById(
    elementId: string,
    options: {
      sourceVersionId?: string;
      sourceLabel?: string;
      skipDiscardConfirmation?: boolean;
      remainInLayout?: boolean;
      inlineSelection?: LayoutSelectionIntent | null;
    } = {},
  ) {
    const sourceLabel = options.sourceLabel ?? "Layout element";
    if (!document || !editorContent) {
      setLocalError(
        `${sourceLabel} could not be opened because the current document structure is not ready. Refresh the document and try again.`,
      );
      return;
    }

    if (
      options.sourceVersionId &&
      options.sourceVersionId !== editorContent.version_id
    ) {
      setLocalError(
        `${document.name}: this ${sourceLabel.toLocaleLowerCase()} belongs to an older document version. The latest layout is being reloaded.`,
      );
      setLayoutView(null);
      setLayoutStatus("idle");
      return;
    }

    const block = editorContent.blocks.find(
      (candidate) => candidate.element_id === elementId,
    );
    if (!block) {
      setLocalError(
        `${document.name}: the selected ${sourceLabel.toLocaleLowerCase()} is no longer mapped in the current document version. Refresh the document and try again.`,
      );
      return;
    }
    if (
      block.document_id !== document.id ||
      block.version_id !== editorContent.version_id
    ) {
      setLocalError(
        `${document.name}: the selected ${sourceLabel.toLocaleLowerCase()} did not match the active document version, so it was not opened.`,
      );
      return;
    }

    if (!block.supported || block.read_only) {
      setLocalError(
        `${document.name} · ${locationLabel(block)}: ${
          block.unsupported_reason ??
          "This Word element is preserved as read-only and cannot be edited in Layout."
        }`,
      );
      return;
    }

    selectBlock(
      block,
      options.skipDiscardConfirmation ?? false,
      options.remainInLayout ?? false,
      options.inlineSelection ?? null,
    );
  }

  function activateSelectedBlock(
    block: EditorBlock,
    remainInLayout = false,
    selection: LayoutSelectionIntent | null = null,
  ) {
    draftTouchedRef.current = false;
    const pendingOperation = pendingEditorOperationForBlock(
      pendingBatch,
      block.element_id,
    );
    const pendingRequest = pendingOperation?.editor_request;
    matchRequestRef.current += 1;
    editorActionRequestRef.current += 1;
    editorActionAbortRef.current?.abort();
    editorActionAbortRef.current = null;

    setSelectedElementId(block.element_id);
    setDraft(pendingDraftForBlock(block, pendingBatch));
    setMatches([]);
    setMatchStatus("idle");
    setNearMatchStatus("idle");
    setLegacyDiscovery(null);
    setIncludedElementIds(
      new Set(pendingRequest?.targets.map((target) => target.element_id) ?? []),
    );
    setTargetReplacements(
      Object.fromEntries(
        pendingRequest?.targets.map((target) => [target.element_id, target.replacement_text]) ?? [],
      ),
    );
    setEditMode(pendingRequest?.edit_mode ?? "shared");
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    setAction(null);
    setStagingStatus(pendingOperation ? "saved" : "idle");
    setEditorResetToken((current) => current + 1);
    setInlineSelection(remainInLayout ? selection : null);

    if (block.supported && !block.read_only) {
      setWorkspaceMode("layout");
    }
  }

  function selectBlock(
    block: EditorBlock,
    skipDiscardConfirmation = false,
    remainInLayout = false,
    selection: LayoutSelectionIntent | null = null,
  ) {
    const changingBlock = block.element_id !== selectedElementId;

    if (!changingBlock) {
      if (block.supported && !block.read_only) {
        setEditorResetToken((current) => current + 1);
        setInlineSelection(remainInLayout ? selection : null);
        setWorkspaceMode("layout");
      }
      return;
    }

    if (!skipDiscardConfirmation && (dirty || perDocumentDirty)) {
      void stageCurrentEdit();
    }
    activateSelectedBlock(block, remainInLayout, selection);
  }

  function exitInlineEditing(regionId: string) {
    setInlineSelection(null);
    window.requestAnimationFrame(() => {
      if (!regionId) return;
      window.document
        .querySelector<HTMLElement>(
          `[data-render-region-id="${CSS.escape(regionId)}"]`,
        )
        ?.focus();
    });
  }

  function issueInlineCommand(command: InlineEditorCommandInput) {
    setInlineCommand({
      ...command,
      id: ++inlineCommandIdRef.current,
    } as InlineEditorCommand);
  }

  function handleDraftChange(nextDraft: QuillDraft) {
    draftTouchedRef.current = true;
    setDraft(nextDraft);
    setStagingStatus("editing");
    setTargetReplacements((current) => ({
      ...current,
      ...(selectedElementId
        ? { [selectedElementId]: nextDraft.text }
        : {}),
    }));
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
  }

  function discardDraft() {
    if (!selectedBlock) return;
    setDraft({
      delta: selectedBlock.delta,
      text: selectedBlock.text,
    });
    setTargetReplacements(
      Object.fromEntries(
        matches.map((match) => [match.element_id, match.text]),
      ),
    );
    setIncludedElementIds(
      new Set(
        matches
          .filter(
            (match) =>
              match.match_type === "source" || match.match_type === "exact",
          )
          .map((match) => match.element_id),
      ),
    );
    setEditorResetToken((current) => current + 1);
    setEditMode("shared");
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    window.requestAnimationFrame(() => {
      findLayoutElement(selectedBlock.element_id)?.focus();
    });
  }

  function toggleTarget(match: EditorMatch) {
    if (match.match_type === "source") return;
    if (editMode === "shared" && match.match_type === "near") return;
    if (match.match_type === "near" && match.decision !== "confirmed") {
      return;
    }
    setIncludedElementIds((current) => {
      const next = new Set(current);
      if (next.has(match.element_id)) next.delete(match.element_id);
      else next.add(match.element_id);
      return next;
    });
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
  }

  function updateDecision(match: EditorMatch, decision: MatchDecision) {
    setMatches((current) =>
      current.map((candidate) =>
        candidate.element_id === match.element_id
          ? { ...candidate, decision }
          : candidate,
      ),
    );
    setIncludedElementIds((current) => {
      const next = new Set(current);
      if (decision === "confirmed" && editMode === "per_document") {
        next.add(match.element_id);
      }
      else next.delete(match.element_id);
      return next;
    });
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");

    if (!selectedBlock) return;
    void saveMatchDecisions(selectedBlock.element_id, [
      { element_id: match.element_id, decision },
    ]).catch((error) => {
      if (!isMissingFeature(error)) {
        setLocalError(
          `${match.document_name}: ${errorMessage(
            error,
            "The match decision could not be saved.",
          )}`,
        );
      }
    });
  }

  function updateEditMode(nextMode: EditorEditMode) {
    setEditMode(nextMode);
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    if (!selectedBlock) return;
    if (nextMode === "full_override") {
      setIncludedElementIds(new Set([selectedBlock.element_id]));
    } else {
      setIncludedElementIds(
        new Set(
          matches
            .filter(
              (match) =>
                match.match_type === "source" ||
                match.match_type === "exact" ||
                (nextMode === "per_document" &&
                  match.decision === "confirmed"),
            )
            .map((match) => match.element_id),
        ),
      );
    }
  }

  function buildOperation(): EditorOperationRequest | null {
    if (!selectedBlock || !draft) return null;
    const chosenMatches =
      editMode === "full_override"
        ? matches.filter(
            (match) => match.element_id === selectedBlock.element_id,
          )
        : matches.filter((match) =>
            includedElementIds.has(match.element_id),
          );
    if (
      !chosenMatches.some(
        (match) => match.element_id === selectedBlock.element_id,
      )
    ) {
      chosenMatches.unshift(
        sourceMatch ?? {
          element_id: selectedBlock.element_id,
          document_id: selectedBlock.document_id,
          document_name: document?.name ?? "Current document",
          version_id: selectedBlock.version_id,
          paragraph_index: selectedBlock.paragraph_index,
          element_type: selectedBlock.element_type,
          text: selectedBlock.text,
          match_type: "source",
          similarity_score: 1,
          decision: "confirmed",
          difference_spans: [],
        },
      );
    }
    const targets = chosenMatches.map((match) => {
      const replacementText =
        editMode === "shared"
          ? draft.text
          : match.element_id === selectedBlock.element_id
            ? draft.text
            : targetReplacements[match.element_id] ?? match.text;
      return {
        element_id: match.element_id,
        replacement_text: replacementText,
        ...(match.element_id === selectedBlock.element_id ||
        editMode === "shared"
          ? { delta: draft.delta }
          : {}),
      };
    });
    const targetDocumentIds = new Set(
      chosenMatches.map((match) => match.document_id),
    );
    return {
      base_versions: Object.fromEntries(
        documentSet.documents
          .filter((item) => targetDocumentIds.has(item.id))
          .map((item) => [
            item.id,
            item.current_version_id ?? item.version_id,
          ]),
      ),
      source_element_id: selectedBlock.element_id,
      edit_mode: editMode,
      targets,
      match_decisions: matches
        .filter(
          (match) =>
            match.match_type === "near" && match.decision !== "pending",
        )
        .map((match) => ({
          element_id: match.element_id,
          decision: match.decision,
        })),
    };
  }

  const operation = buildOperation();
  const operationSignature = operation ? JSON.stringify(operation) : "";
  const hasChangedOperation =
    editMode === "per_document"
      ? sourceDiffersFromBase || perDocumentDirty
      : sourceDiffersFromBase;
  const validTargets = Boolean(
    operation?.targets.length &&
      operation.targets.every(
        (target) => target.replacement_text.trim().length > 0,
      ),
  );
  const canPreview = Boolean(
    selectedBlock?.supported &&
      !selectedBlock.read_only &&
      validTargets &&
      hasChangedOperation &&
      matchStatus === "ready" &&
      !action &&
      !pendingGenerationId,
  );
  const canGenerate = Boolean(
    canPreview &&
      preview &&
      previewSignature === operationSignature &&
      !action,
  );
  const canAddToBatch = Boolean(
    operation &&
      preview &&
      previewSignature === operationSignature &&
      !action &&
      batchAddedSignature !== operationSignature,
  );

  async function stageCurrentEdit() {
    if (!operation || !selectedBlock) return;
    setStagingStatus("saving");
    try {
      if (!hasChangedOperation) {
        await removeEditorEditFromPendingBatch(documentSet.id, selectedBlock.element_id);
        draftTouchedRef.current = false;
        setPendingBatch((current) =>
          current
            ? {
                ...current,
                operations: current.operations.filter(
                  (candidate) =>
                    candidate.editor_request?.source_element_id !== selectedBlock.element_id,
                ),
              }
            : current,
        );
        setStagingStatus("idle");
      } else {
        await addEditorEditToPendingBatch(documentSet.id, operation, `${document?.name ?? "Document"} · ${locationLabel(selectedBlock)}`);
        setBatchAddedSignature(operationSignature);
        setStagingStatus("saved");
      }
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (caught) {
      setStagingStatus("error");
      setLocalError(errorMessage(caught, "The change could not be staged. Retry to keep it in Pending Changes."));
    }
  }

  useEffect(() => {
    if (!selectedBlock || !operation || (!hasChangedOperation && !draftTouchedRef.current)) return;
    const timer = window.setTimeout(() => void stageCurrentEdit(), 650);
    return () => window.clearTimeout(timer);
  }, [operationSignature, selectedBlock?.element_id]);

  async function handlePreview() {
    if (!operation || !selectedBlock) return;
    editorActionAbortRef.current?.abort();
    const requestId = ++editorActionRequestRef.current;
    const controller = new AbortController();
    editorActionAbortRef.current = controller;
    setAction("preview");
    setLocalError("");
    try {
      let result: EditorPreviewResponse;
      try {
        result = await previewEditorEdit(
          documentSet.id,
          operation,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          !isMissingFeature(error) ||
          editMode !== "shared" ||
          !legacyDiscovery?.link_group
        ) {
          throw error;
        }
        result = legacyPreview(
          await previewEdit(
            documentSet.id,
            legacyDiscovery.link_group.id,
            draft?.text ?? "",
            selectedBlock.element_id,
            operation.targets.map((target) => target.element_id),
            controller.signal,
          ),
          editMode,
        );
      }
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }
      setPreview(result);
      setPreviewOpen(true);
      setPreviewSignature(operationSignature);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setLocalError(
          `${document?.name ?? "Document"} changed since this editor opened. The latest version is being reloaded; review the block again before previewing.`,
        );
        setRefreshToken((current) => current + 1);
      } else {
        setLocalError(
          `${document?.name ?? "Document"} · ${locationLabel(
            selectedBlock,
          )}: ${errorMessage(error, "The edit preview failed.")}`,
        );
      }
    } finally {
      if (requestId === editorActionRequestRef.current) {
        if (editorActionAbortRef.current === controller) {
          editorActionAbortRef.current = null;
        }
        setAction(null);
      }
    }
  }

  async function handleGenerate() {
    if (
      !operation ||
      !selectedBlock ||
      !canGenerate ||
      generationSubmissionRef.current
    ) {
      return;
    }
    generationSubmissionRef.current = true;
    const generationStartedAt = performance.now();
    editorActionAbortRef.current?.abort();
    const requestId = ++editorActionRequestRef.current;
    const controller = new AbortController();
    editorActionAbortRef.current = controller;
    setAction("generate");
    setLocalError("");
    try {
      let result: EditorGenerationResponse | null = null;
      try {
        const queued = await queueEditorEdit(
          documentSet.id,
          operation,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          requestId !== editorActionRequestRef.current
        ) {
          return;
        }
        console.info("DocuSync generation queued", {
          generationId: queued.generation_id,
          requestMs: Math.round(performance.now() - generationStartedAt),
          serverTimings: queued.timings,
        });
        generationStartedAtRef.current.set(
          queued.generation_id,
          generationStartedAt,
        );

        const previousEditorContent = editorContent;
        const optimisticTarget = operation.targets.find(
          (target) => target.element_id === selectedBlock.element_id,
        );
        setPendingGenerationId(queued.generation_id);
        setLastGeneration(queued);
        queuedGenerationSnapshotRef.current = {
          jobId: queued.generation_id,
          documentId: documentContextRef.current.documentId,
          content: previousEditorContent,
        };
        onGenerationQueued(queued);
        setPreview(null);
        setPreviewOpen(false);
        setPreviewSignature("");
        if (optimisticTarget) {
          setEditorContent((current) =>
            current
              ? {
                  ...current,
                  blocks: current.blocks.map((block) =>
                    block.element_id === optimisticTarget.element_id
                      ? {
                          ...block,
                          text: optimisticTarget.replacement_text,
                          delta: optimisticTarget.delta ?? block.delta,
                        }
                      : block,
                  ),
                }
              : current,
          );
          setDraft((current) =>
            current
              ? {
                  text: optimisticTarget.replacement_text,
                  delta: optimisticTarget.delta ?? current.delta,
                }
              : current,
          );
        }
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isMissingEndpoint(error)) {
          throw error;
        }
        try {
          result = await generateEditorEdit(
            documentSet.id,
            operation,
            controller.signal,
          );
        } catch (fallbackError) {
          if (
            controller.signal.aborted ||
            !isMissingFeature(fallbackError) ||
            editMode !== "shared" ||
            !legacyDiscovery?.link_group
          ) {
            throw fallbackError;
          }
          const compatible = await generateEdit(
            documentSet.id,
            legacyDiscovery.link_group.id,
            draft?.text ?? "",
            selectedBlock.element_id,
            operation.targets.map((target) => target.element_id),
            controller.signal,
          );
          result = {
            generation_id: compatible.generation_id,
            status: compatible.status,
            download_url: compatible.download_url,
            document_set: compatible.document_set,
            files: compatible.files,
          };
        }
      }
      if (
        !result ||
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }

      setLastGeneration(result);
      console.info("DocuSync generation ready", {
        generationId: result.generation_id,
        status: result.status,
        totalMs: Math.round(performance.now() - generationStartedAt),
        serverTimings: result.timings,
      });
      onGenerated(result);
      setPreview(null);
      setPreviewOpen(false);
      setPreviewSignature("");
      setSelectedElementId("");
      setDraft(null);
      setMatches([]);
      setIncludedElementIds(new Set());
      setRefreshToken((current) => current + 1);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setLocalError(error.message);
        if (!error.message.includes("background update in progress")) {
          setRefreshToken((current) => current + 1);
        }
      } else {
        setLocalError(
          `${document?.name ?? "Document"} · ${locationLabel(
            selectedBlock,
          )}: ${errorMessage(
            error,
            "Generation failed. No document version was created.",
          )}`,
        );
      }
    } finally {
      generationSubmissionRef.current = false;
      if (requestId === editorActionRequestRef.current) {
        if (editorActionAbortRef.current === controller) {
          editorActionAbortRef.current = null;
        }
        setAction(null);
      }
    }
  }

  async function handleAddToBatch() {
    if (!operation || !selectedBlock || !canAddToBatch) return;
    editorActionAbortRef.current?.abort();
    const requestId = ++editorActionRequestRef.current;
    const controller = new AbortController();
    editorActionAbortRef.current = controller;
    setAction("batch");
    setLocalError("");
    try {
      await addEditorEditToPendingBatch(
        documentSet.id,
        operation,
        `${document?.name ?? "Document"} · ${locationLabel(selectedBlock)}`,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }
      setBatchAddedSignature(operationSignature);
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (caught) {
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }
      setLocalError(
        errorMessage(
          caught,
          "The reviewed edit could not be added to pending changes.",
        ),
      );
    } finally {
      if (requestId === editorActionRequestRef.current) {
        if (editorActionAbortRef.current === controller) {
          editorActionAbortRef.current = null;
        }
        setAction(null);
      }
    }
  }

  function dismissEditorError() {
    setRestoreError("");
    setLocalError("");
  }

  if (!document) {
    return (
      <>
        <section className="viewer-panel">
          <div className="editor-loading-state">Choose a document.</div>
        </section>
        <aside className="edit-sidebar">
          <div className="sidebar-empty">No document selected.</div>
        </aside>
      </>
    );
  }

  const currentVersionId =
    versions?.current_version_id ??
    editorContent?.version_id ??
    document.current_version_id ??
    document.version_id;
  const currentVersion =
    versions?.versions.find((version) => version.id === currentVersionId) ??
    versions?.versions.find((version) => version.is_current);
  const versionNumber =
    currentVersion?.version_number ??
    editorContent?.version_number ??
    document.version_number ??
    1;
  const nextVersionNumber =
    Math.max(
      0,
      ...(versions?.versions.map((version) => version.version_number) ?? []),
    ) + 1;
  const currentDownloadHref = currentVersion?.download_url
    ? absoluteApiUrl(currentVersion.download_url)
    : versionApiAvailable
      ? versionDownloadUrl(currentVersionId)
      : currentDocumentDownloadUrl(document.id);
  const draftMayOverflow = Boolean(
    selectedBlock &&
      draft &&
      draft.text.length >
        Math.max(
          selectedBlock.text.length * 1.35,
          selectedBlock.text.length + 40,
        ),
  );

  async function handleRestoreVersion(version: DocumentVersion) {
    if (!document || version.is_current || action) return;
    const activeDocument = document;
    const documentContextToken = documentContextRef.current.token;
    const draftWarning =
      dirty || perDocumentDirty
        ? "\n\nYour uncommitted draft will be discarded."
        : "";
    const confirmed = window.confirm(
      `Restore Version ${version.version_number}?\n\nDocSync will create Version ${nextVersionNumber} from it. The current version remains in history.${draftWarning}`,
    );
    if (!confirmed) return;

    setAction("restore");
    setRestoringVersionId(version.id);
    setLocalError("");
    setRestoreNotice("");
    setRestoreError("");
    try {
      const result = await restoreDocumentVersion(
        activeDocument.id,
        version.id,
        currentVersionId,
      );
      if (!mountedRef.current) return;
      onGenerated({
        generation_id: result.generation_id ?? result.operation_id,
        status: result.status,
        document_set: result.document_set,
        versions: [result.version],
      });
      if (
        activeDocumentIdRef.current !== activeDocument.id ||
        documentContextRef.current.token !== documentContextToken
      ) {
        return;
      }

      const restoredVersions = [
        result.version,
        ...(versions?.versions ?? []).filter(
          (candidate) => candidate.id !== result.version.id,
        ),
      ]
        .map((candidate) => ({
          ...candidate,
          is_current: candidate.id === result.version.id,
        }))
        .sort((left, right) => right.version_number - left.version_number);

      setVersions({
        document_id: activeDocument.id,
        current_version_id: result.version.id,
        versions: restoredVersions,
      });
      setVersionStatus("ready");
      setVersionApiAvailable(true);
      setEditorContent(null);
      setContentStatus("loading");
      setSelectedElementId("");
      setDraft(null);
      setMatches([]);
      setIncludedElementIds(new Set());
      setTargetReplacements({});
      setEditMode("shared");
      setPreview(null);
      setPreviewOpen(false);
      setPreviewSignature("");
      setLastGeneration(null);
      setEditorResetToken((current) => current + 1);
      setLayoutView(null);
      setLayoutStatus("idle");
      setWorkspaceMode("layout");
      setRestoreNotice(
        `Version ${result.version.version_number} was created from Version ${result.restored_from_version_number}.`,
      );
      versionHistoryRef.current?.removeAttribute("open");
      setRefreshToken((current) => current + 1);
    } catch (error) {
      if (!mountedRef.current) return;
      if (
        activeDocumentIdRef.current !== activeDocument.id ||
        documentContextRef.current.token !== documentContextToken
      ) {
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setRestoreError(
          `${activeDocument.name} changed after version history was opened. No version was restored. The latest history is being reloaded.`,
        );
        setRefreshToken((current) => current + 1);
      } else {
        setRestoreError(
          `${activeDocument.name}: ${errorMessage(
            error,
            "The selected version could not be restored.",
          )}`,
        );
      }
    } finally {
      if (mountedRef.current) {
        setAction(null);
        setRestoringVersionId("");
      }
    }
  }

  return (
    <>
      <section
        className="viewer-panel editor-experience"
        aria-labelledby="editor-document-title"
      >
        <header className="editor-document-header">
          <div className="editor-document-identity">
            <span className="word-icon" aria-hidden="true">
              W
            </span>
            <div>
              <strong id="editor-document-title">{document.name}</strong>
              <span>
                Version {versionNumber} · {currentVersionId.slice(0, 8)}
              </span>
            </div>
          </div>
          <div className="editor-document-actions">
            <a
              className="quiet-button"
              href={currentDownloadHref}
              download
            >
              Download current
            </a>
            <details
              ref={versionHistoryRef}
              className="version-history"
              aria-busy={action === "restore"}
              onToggle={(event) => {
                if (event.currentTarget.open) {
                  setHistoryRequested(true);
                }
              }}
            >
              <summary>
                Version history
                {versionStatus === "loading" ? "…" : ""}
              </summary>
              <div className="version-history-menu">
                {versionStatus === "loading" && (
                  <div className="compact-loading" role="status">
                    Loading version historyâ€¦
                  </div>
                )}
                {versions?.versions.map((version) => (
                  <article
                    className={`version-history-item ${
                      version.is_current ? "current" : ""
                    }`}
                    key={version.id}
                  >
                    <span>
                      <strong>
                        Version {version.version_number}
                        {version.is_current ? " · Current" : ""}
                      </strong>
                      <small>{formatDate(version.created_at)}</small>
                      {version.restored_from_version_number != null && (
                        <small>
                          Restored from Version{" "}
                          {version.restored_from_version_number}
                        </small>
                      )}
                    </span>
                    <div className="version-history-actions">
                      <a
                        href={
                          version.download_url
                            ? absoluteApiUrl(version.download_url)
                            : versionApiAvailable
                              ? versionDownloadUrl(version.id)
                              : currentDocumentDownloadUrl(document.id)
                        }
                        download
                      >
                        Download
                      </a>
                      {!version.is_current && versionApiAvailable && (
                        <button
                          type="button"
                          disabled={Boolean(action)}
                          onClick={() => void handleRestoreVersion(version)}
                        >
                          {restoringVersionId === version.id
                            ? "Restoring…"
                            : "Restore"}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </details>
          </div>
        </header>


        {restoreNotice && (
          <div className="editor-restore-notice" role="status">
            <strong>Version restored</strong>
            <span>{restoreNotice}</span>
          </div>
        )}

        {(restoreError || localError) && (
          <div className="editor-inline-error" role="alert">
            <strong>Action needed</strong>
            <span>{restoreError || localError}</span>
            <button
              type="button"
              onClick={dismissEditorError}
              aria-label="Dismiss error message"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div
          className="editor-mode-scroll"
          ref={modeScrollRef}
          onScroll={handleModeScroll}
        >
          <section
            id="workspace-panel-layout"
            aria-label="Document layout"
            className="editor-mode-panel layout-mode-panel"
          >
            {(layoutStatus === "loading" ||
              (contentStatus === "loading" && !layoutView && !editorContent)) && (
              <div className="editor-loading-state nonblocking" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>
                  <strong>
                    {layoutView || editorContent
                      ? "Updating preview…"
                      : "Opening document…"}
                  </strong>
                  {layoutView || editorContent
                    ? ` ${previewStageLabel(previewJob?.stage)} continues in the background.`
                    : " Loading the cached document content."}
                </span>
              </div>
            )}
            {layoutStatus === "error" && !layoutView?.pdf_url && (
              <div className="editor-empty-state">
                <strong>Layout preview unavailable</strong>
                <p>
                  Retry the Word preview after closing any open Word dialogue.
                </p>
              </div>
            )}
            {layoutView?.pdf_url && (
              <div className="layout-iframe-shell">
                <WordPreviewOverlay
                  documentSetId={documentSet.id}
                  documentName={document.name}
                  versionId={layoutView.version_id}
                  previewPages={layoutView.pages}
                  selectedElementId={selectedElementId}
                  selectedBlock={selectedBlock}
                  draft={draft}
                  pendingOverridesByElementId={pendingLayoutOverridesByElementId}
                  editorResetToken={editorResetToken}
                  inlineSelection={inlineSelection}
                  inlineCommand={inlineCommand}
                  editorDisabled={action === "generate"}
                  onSelect={(intent) =>
                    selectElementById(intent.elementId, {
                      sourceVersionId: intent.versionId,
                      sourceLabel: "Word preview region",
                      remainInLayout: true,
                      inlineSelection: intent,
                    })
                  }
                  onDraftChange={handleDraftChange}
                  onExitInline={exitInlineEditing}
                  onRetryPreview={() => void loadWordPreview(true)}
                />
              </div>
            )}
          </section>

        </div>
      </section>

      <aside
        className="edit-sidebar editor-operation-sidebar"
        aria-labelledby="editor-operation-title"
      >
        {!selectedBlock ? (
          <>
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Inline editing</span>
                <h2 id="editor-operation-title">Select text in Layout</h2>
              </div>
            </div>
            <div className="sidebar-empty">
              <span aria-hidden="true">W</span>
              <h3>Click supported Word text</h3>
              <p>
                A restricted editor will appear over the selected paragraph.
                Uncertain mappings and complex Word structures stay read-only.
              </p>
            </div>
          </>
        ) : !selectedBlock.supported || selectedBlock.read_only ? (
          <>
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Safe degradation</span>
                <h2 id="editor-operation-title">Read-only block</h2>
              </div>
            </div>
            <div className="read-only-sidebar">
              <strong>{locationLabel(selectedBlock)}</strong>
              <p>
                {selectedBlock.unsupported_reason ??
                  "This Word structure cannot be edited safely in the first release."}
              </p>
              <span>
                It remains in the original DOCX and will not be silently
                removed or rewritten.
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Controlled edit</span>
                <h2 id="editor-operation-title">Layout editing</h2>
              </div>
              <span className={`draft-status ${stagingStatus === "error" ? "dirty" : ""}`} role="status">
                {stagingStatus === "editing"
                  ? "Editing"
                  : stagingStatus === "saving"
                    ? "Saving…"
                    : stagingStatus === "saved"
                      ? `✓ Pending${pendingEditorOperation ? ` · ${pendingEditorOperation.occurrence_count || pendingEditorOperation.editor_request?.targets.length || 1} locations · ${pendingEditorOperation.document_count || Object.keys(pendingEditorOperation.editor_request?.base_versions ?? {}).length || 1} documents` : ""}`
                      : stagingStatus === "error"
                        ? "Could not add to Pending Changes · Retry"
                        : "No pending edit"}
              </span>
            </div>
            <div className="operation-sidebar-scroll">
              {mode === "layout" && (
                <>
                  {draftMayOverflow && (
                    <div className="inline-overflow-warning" role="status">
                      <strong>This draft may wrap differently in the final Word document.</strong>
                      <span>Generate a new version to view the accurate layout.</span>
                    </div>
                  )}
                  {!inlineSelection && (
                    <p className="inline-editor-paused">
                      Inline typing is paused. Select a highlighted area in the
                      Word preview to place the cursor in that block.
                    </p>
                  )}
                  <div
                    className="inline-formatting-toolbar"
                    role="toolbar"
                    aria-label="Inline text and paragraph formatting"
                  >
                    <button type="button" onClick={() => issueInlineCommand({ action: "bold" })}>Bold</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "italic" })}>Italic</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "underline" })}>Underline</button>
                    <select
                      aria-label="Heading level"
                      defaultValue=""
                      disabled={["table_paragraph", "header_paragraph", "footer_paragraph"].includes(selectedBlock.element_type)}
                      onChange={(event) => {
                        const value = event.target.value;
                        issueInlineCommand({ action: "heading", value: value ? Number(value) : false });
                      }}
                    >
                      <option value="">Normal</option>
                      <option value="1">Heading 1</option>
                      <option value="2">Heading 2</option>
                      <option value="3">Heading 3</option>
                    </select>
                    <button type="button" onClick={() => issueInlineCommand({ action: "list", value: "ordered" })}>Numbered</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "list", value: "bullet" })}>Bullets</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "indent", value: -1 })}>Outdent</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "indent", value: 1 })}>Indent</button>
                    <select
                      aria-label="Paragraph alignment"
                      defaultValue=""
                      onChange={(event) =>
                        issueInlineCommand({
                          action: "align",
                          value: event.target.value as "" | "center" | "right" | "justify",
                        })
                      }
                    >
                      <option value="">Left</option>
                      <option value="center">Centre</option>
                      <option value="right">Right</option>
                      <option value="justify">Justify</option>
                    </select>
                    <button type="button" onClick={() => issueInlineCommand({ action: "undo" })}>Undo</button>
                    <button type="button" onClick={() => issueInlineCommand({ action: "redo" })}>Redo</button>
                  </div>
                </>
              )}

              <fieldset className="edit-mode-options">
                <legend>Update mode</legend>
                <label className={editMode === "shared" ? "selected" : ""}>
                  <input
                    type="radio"
                    name="editor-edit-mode"
                    value="shared"
                    checked={editMode === "shared"}
                    onChange={() => updateEditMode("shared")}
                  />
                  <span>
                    <strong>Shared wording</strong>
                    <small>
                      Apply the Layout draft to checked exact matches. Near
                      matches stay protected.
                    </small>
                  </span>
                </label>
                <label
                  className={
                    editMode === "per_document" ? "selected" : ""
                  }
                >
                  <input
                    type="radio"
                    name="editor-edit-mode"
                    value="per_document"
                    checked={editMode === "per_document"}
                    onChange={() => updateEditMode("per_document")}
                  />
                  <span>
                    <strong>Per-document values</strong>
                    <small>Provide a distinct result for each target.</small>
                  </span>
                </label>
                <label
                  className={
                    editMode === "full_override" ? "selected" : ""
                  }
                >
                  <input
                    type="radio"
                    name="editor-edit-mode"
                    value="full_override"
                    checked={editMode === "full_override"}
                    onChange={() => updateEditMode("full_override")}
                  />
                  <span>
                    <strong>Whole-paragraph override</strong>
                    <small>
                      Change only the source and detach it from shared updates.
                    </small>
                  </span>
                </label>
              </fieldset>

              <section className="operation-target-summary">
                <header>
                  <div>
                    <h3>Selected targets</h3>
                    <p>
                      Exact matches are safe by default. Review near matches
                      below before including them.
                    </p>
                  </div>
                  <span>
                    {operation?.targets.length ?? 0}
                  </span>
                </header>
                {editMode !== "full_override" && (
                  <div className="compact-target-list">
                    {matches.map((match) => (
                      <label key={match.element_id}>
                        <input
                          type="checkbox"
                          checked={includedElementIds.has(match.element_id)}
                          disabled={
                            match.match_type === "source" ||
                            (match.match_type === "near" &&
                              (match.decision !== "confirmed" ||
                                editMode === "shared"))
                          }
                          onChange={() => toggleTarget(match)}
                        />
                        <span>
                          <strong>{match.document_name}</strong>
                          <small>
                            {match.match_type === "source"
                              ? "Source · always included"
                              : match.match_type === "exact"
                                ? "Exact match"
                                : `Near · ${Math.round(
                                    match.similarity_score * 100,
                                  )}% · ${match.decision}${
                                    editMode === "shared"
                                      ? " · use per-document mode"
                                      : ""
                                  }`}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {matchStatus === "loading" && (
                  <p className="compact-loading">Finding related blocks…</p>
                )}
              </section>

              {mode === "layout" &&
                matches.some((match) => match.match_type === "near") && (
                  <section className="layout-near-matches" aria-labelledby="layout-near-title">
                    <h3 id="layout-near-title">Near matches</h3>
                    <p>Review word-level differences and explicitly include or exclude each candidate.</p>
                    {matches
                      .filter((match) => match.match_type === "near")
                      .map((match) => (
                        <article key={match.element_id}>
                          <header>
                            <strong>{match.document_name}</strong>
                            <span>{Math.round(match.similarity_score * 100)}%</span>
                          </header>
                          <p><DifferenceText spans={match.difference_spans} /></p>
                          <div role="group" aria-label={`Near-match decision for ${match.document_name}`}>
                            <button
                              type="button"
                              className={match.decision === "confirmed" ? "active" : ""}
                              onClick={() => updateDecision(match, "confirmed")}
                            >
                              Include
                            </button>
                            <button
                              type="button"
                              className={match.decision === "ignored" ? "active" : ""}
                              onClick={() => updateDecision(match, "ignored")}
                            >
                              Exclude
                            </button>
                          </div>
                        </article>
                      ))}
                  </section>
                )}

              {editMode === "per_document" && (
                <section className="per-document-values">
                  <h3>Result for each document</h3>
                  {matches
                    .filter(
                      (match) =>
                        includedElementIds.has(match.element_id) &&
                        match.element_id !== selectedBlock.element_id,
                    )
                    .map((match) => (
                      <label key={match.element_id}>
                        <span>{match.document_name}</span>
                        <textarea
                          rows={4}
                          maxLength={20_000}
                          value={
                            targetReplacements[match.element_id] ?? match.text
                          }
                          onChange={(event) => {
                            const value = event.target.value;
                            setTargetReplacements((current) => ({
                              ...current,
                              [match.element_id]: value,
                            }));
                            setPreview(null);
                            setPreviewOpen(false);
                            setPreviewSignature("");
                          }}
                        />
                      </label>
                    ))}
                  <p className="per-document-source-note">
                    Edit the source document in Quill above. These fields
                    control only the other selected documents.
                  </p>
                </section>
              )}

              <div className="operation-actions">
                {stagingStatus === "error" && <button type="button" className="quiet-button" onClick={() => void stageCurrentEdit()}>Retry staging</button>}
                <span className="generate-safety-copy">Edits are staged here. Preview and apply all pending changes from the toolbar.</span>
              </div>
            

              {preview && previewSignature === operationSignature && (
                <div className="preview-ready-state" role="status">
                  <strong>Preview ready</strong>
                  <span>
                    {preview.affected_location_count} reviewed location
                    {preview.affected_location_count === 1 ? "" : "s"}. Generate
                    remains a separate action.
                  </span>
                  <button type="button" onClick={() => setPreviewOpen(true)}>
                    Reopen preview
                  </button>
                </div>
              )}

              {lastGeneration && (
                <div
                  className={`generation-ready-state ${
                    ["queued", "processing"].includes(lastGeneration.status)
                      ? "processing"
                      : lastGeneration.status
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  <strong>
                    {["queued", "processing"].includes(lastGeneration.status)
                      ? "Update accepted"
                      : lastGeneration.status === "completed"
                        ? "New versions created"
                        : "Update needs attention"}
                  </strong>
                  <span>
                    {["queued", "processing"].includes(lastGeneration.status)
                      ? "Your change is already reflected here. DocSync is creating and validating the Word versions in the background."
                      : lastGeneration.status === "completed"
                        ? "The Word versions are ready and the editor mappings were refreshed."
                        : lastGeneration.error_detail ??
                          "The background update did not complete."}
                  </span>
                  {lastGeneration.status === "completed" &&
                    lastGeneration.download_url && (
                      <a href={absoluteApiUrl(lastGeneration.download_url)}>
                        Download generated set
                      </a>
                    )}
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {preview && previewOpen && (
        <PreviewDialog
          preview={preview}
          onClose={() => setPreviewOpen(false)}
          restoreFocus={previewButtonRef}
        />
      )}
    </>
  );
}
