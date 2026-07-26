import {
  Fragment,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  absoluteApiUrl,
  ApiError,
  compareDocumentElements,
  currentDocumentDownloadUrl,
  fetchDocumentVersions,
  fetchDocumentView,
  fetchEditorContent,
  fetchElementMatches,
  fetchSimilarMatches,
  generateEdit,
  generateEditorEdit,
  previewEdit,
  previewEditorEdit,
  renderDocumentView,
  restoreDocumentVersion,
  saveMatchDecisions,
  versionDownloadUrl,
} from "./api";
import {
  candidateArrays,
  editorContentFromView,
  normaliseEditorContent,
  normaliseMatch,
  textFromDelta,
  wordDifferenceSpans,
} from "./editorUtils";
import QuillBlockEditor, {
  type QuillDraft,
} from "./QuillBlockEditor";
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
  EditorGenerationResponse,
  EditorMatch,
  EditorOperationRequest,
  EditorPreviewResponse,
  MatchDecision,
  MatchDiscovery,
  PreviewResponse,
  QuillDelta,
} from "./types";

type WorkspaceMode = "layout" | "edit" | "compare";
type LoadingStatus = "idle" | "loading" | "ready" | "error";
type EditorAction = "preview" | "generate" | "restore" | null;

interface DocumentExperienceProps {
  documentSet: DocumentSetResponse;
  document: DocumentSummary | null;
  fallbackView: DocumentView | null;
  searchTarget: DocumentSearchTarget | null;
  onGenerated: (result: EditorGenerationResponse) => void;
  onDirtyChange: (dirty: boolean) => void;
}

const WORKSPACE_MODES: Array<{
  id: WorkspaceMode;
  label: string;
  description: string;
}> = [
  {
    id: "layout",
    label: "Layout",
    description: "Read-only Word layout",
  },
  {
    id: "edit",
    label: "Edit",
    description: "Structured Quill editor",
  },
  {
    id: "compare",
    label: "Compare",
    description: "Exact and near matches",
  },
];

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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function locationLabel(item: {
  element_type: string;
  paragraph_index: number;
  table_index?: number;
  row_index?: number;
  column_index?: number;
}): string {
  if (
    item.element_type === "table_cell" &&
    item.table_index !== undefined &&
    item.row_index !== undefined &&
    item.column_index !== undefined
  ) {
    return `Table ${item.table_index + 1} · row ${item.row_index + 1} · column ${
      item.column_index + 1
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

function applyInlineFormatting(
  text: string,
  attributes: Record<string, unknown>,
): ReactNode {
  let content: ReactNode = text;
  if (attributes.bold) content = <strong>{content}</strong>;
  if (attributes.italic) content = <em>{content}</em>;
  if (attributes.underline) content = <u>{content}</u>;
  return content;
}

function inlineDelta(
  delta: QuillDelta,
  highlight?: { start: number; end: number },
): ReactNode[] {
  let textOffset = 0;
  return delta.ops.flatMap((operation, index) => {
    if (typeof operation.insert !== "string") {
      return [
        <span className="unsupported-inline" key={`embed-${index}`}>
          [Unsupported embedded content]
        </span>,
      ];
    }
    const text = operation.insert.replace(/\n$/, "");
    if (!text) return [];
    const attributes = operation.attributes ?? {};
    const operationStart = textOffset;
    const operationEnd = operationStart + text.length;
    textOffset = operationEnd;

    if (
      !highlight ||
      highlight.end <= operationStart ||
      highlight.start >= operationEnd
    ) {
      return [
        <Fragment key={`text-${index}`}>
          {applyInlineFormatting(text, attributes)}
        </Fragment>,
      ];
    }

    const localStart = Math.max(0, highlight.start - operationStart);
    const localEnd = Math.min(text.length, highlight.end - operationStart);
    const pieces = [
      { kind: "before", text: text.slice(0, localStart) },
      { kind: "match", text: text.slice(localStart, localEnd) },
      { kind: "after", text: text.slice(localEnd) },
    ];
    return pieces
      .filter((piece) => piece.text)
      .map((piece) => {
        const content = applyInlineFormatting(piece.text, attributes);
        return piece.kind === "match" ? (
          <mark
            className="editor-block-search-hit"
            key={`text-${index}-${piece.kind}`}
          >
            {content}
          </mark>
        ) : (
          <Fragment key={`text-${index}-${piece.kind}`}>
            {content}
          </Fragment>
        );
      });
  });
}

function findEditorBlockCard(elementId: string): HTMLElement | null {
  return (
    Array.from(
      window.document.querySelectorAll<HTMLElement>(
        ".editor-block-card[data-element-id]",
      ),
    ).find((card) => card.dataset.elementId === elementId) ?? null
  );
}

function BlockCard({
  block,
  selected,
  searchRange,
  onSelect,
}: {
  block: EditorBlock;
  selected: boolean;
  searchRange?: { start: number; end: number };
  onSelect: (block: EditorBlock) => void;
}) {
  const alignment = block.alignment ?? "left";
  const isUnsupported = !block.supported || block.read_only;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(block);
  }

  return (
    <div
      className={`editor-block-card ${block.element_type} ${
        selected ? "selected" : ""
      } ${isUnsupported ? "read-only" : ""} ${
        searchRange ? "search-target" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${isUnsupported ? "Inspect read-only" : "Edit"} ${
        block.element_type
      }: ${block.text}`}
      data-element-id={block.element_id}
      data-block-order={block.order}
      onClick={() => onSelect(block)}
      onKeyDown={handleKeyDown}
    >
      <div className="editor-block-meta">
        <span>{locationLabel(block)}</span>
        <span className={`support-label ${isUnsupported ? "read-only" : ""}`}>
          {isUnsupported ? "Read-only" : selected ? "Editing" : "Supported"}
        </span>
      </div>
      <div
        className={`editor-block-content align-${alignment} indent-${Math.min(
          8,
          Math.max(0, block.indent ?? 0),
        )}`}
      >
        {block.element_type === "list_item" && (
          <span className="editor-list-marker" aria-hidden="true">
            {block.list_type === "ordered" ? "1." : "•"}
          </span>
        )}
        <span>{inlineDelta(block.delta, searchRange)}</span>
      </div>
      {block.unsupported_reason && (
        <p className="editor-block-reason">{block.unsupported_reason}</p>
      )}
    </div>
  );
}

function LayoutFallbackBlock({
  block,
  selected,
  onSelect,
}: {
  block: EditorBlock;
  selected: boolean;
  onSelect: (block: EditorBlock) => void;
}) {
  const editable = block.supported && !block.read_only;
  const alignment = block.alignment ?? "left";
  const className = `layout-fallback-block ${block.element_type} ${
    selected ? "selected" : ""
  } ${editable ? "editable" : "read-only"}`;
  const content = (
    <>
      <span className="layout-fallback-meta">
        <span>{locationLabel(block)}</span>
        <span>
          {editable
            ? selected
              ? "Selected"
              : "Open in editor"
            : "Read-only"}
        </span>
      </span>
      <span
        className={`layout-fallback-content align-${alignment} indent-${Math.min(
          8,
          Math.max(0, block.indent ?? 0),
        )}`}
      >
        {block.element_type === "list_item" && (
          <span className="editor-list-marker" aria-hidden="true">
            {block.list_type === "ordered" ? "1." : "•"}
          </span>
        )}
        <span>{inlineDelta(block.delta)}</span>
      </span>
      {!editable && block.unsupported_reason && (
        <span className="layout-fallback-reason">
          {block.unsupported_reason}
        </span>
      )}
    </>
  );

  if (!editable) {
    return (
      <div
        className={className}
        aria-label={`Read-only ${block.element_type}: ${block.text}${
          block.unsupported_reason ? `. ${block.unsupported_reason}` : ""
        }`}
        data-element-id={block.element_id}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      aria-pressed={selected}
      aria-label={`Open ${block.element_type.replaceAll("_", " ")} in editor: ${
        block.text
      }`}
      title="Open in editor"
      data-element-id={block.element_id}
      onClick={() => onSelect(block)}
    >
      {content}
    </button>
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

function DiscardDraftDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onCancel();
        }
      }}
    >
      <section
        className="preview-dialog discard-draft-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-draft-title"
        aria-describedby="discard-draft-description"
      >
        <header className="preview-dialog-header">
          <div>
            <p className="eyebrow">Unsaved editor draft</p>
            <h2 id="discard-draft-title">Discard the current draft?</h2>
            <p id="discard-draft-description">
              Choose OK to open the selected block and discard the current
              unpreviewed draft. Choose Cancel to keep editing the current
              block.
            </p>
          </div>
        </header>
        <footer className="preview-dialog-footer">
          <div>
            <strong>No files have been changed</strong>
            <span>This only affects the draft currently shown in the editor.</span>
          </div>
          <div>
            <button
              ref={cancelRef}
              type="button"
              className="quiet-button"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={onConfirm}
            >
              OK
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
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
                  </p>
                </div>
              </header>
              {document.changes.map((change) => (
                <div className="diff" key={change.element_id}>
                  <p className="location-label">{locationLabel(change)}</p>
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
  fallbackView,
  searchTarget,
  onGenerated,
  onDirtyChange,
}: DocumentExperienceProps) {
  const [mode, setMode] = useState<WorkspaceMode>("edit");
  const [editorContent, setEditorContent] =
    useState<EditorContentResponse | null>(null);
  const [contentStatus, setContentStatus] =
    useState<LoadingStatus>("idle");
  const [layoutView, setLayoutView] = useState<DocumentView | null>(null);
  const [layoutStatus, setLayoutStatus] =
    useState<LoadingStatus>("idle");
  const [layoutRefresh, setLayoutRefresh] = useState(0);
  const [showLayoutStructure, setShowLayoutStructure] = useState(false);
  const [selectedElementId, setSelectedElementId] = useState("");
  const [draft, setDraft] = useState<QuillDraft | null>(null);
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [pendingBlockSelection, setPendingBlockSelection] =
    useState<EditorBlock | null>(null);
  const [matches, setMatches] = useState<EditorMatch[]>([]);
  const [matchStatus, setMatchStatus] =
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
  const [action, setAction] = useState<EditorAction>(null);
  const [localError, setLocalError] = useState("");
  const [versions, setVersions] =
    useState<DocumentVersionsResponse | null>(null);
  const [versionStatus, setVersionStatus] =
    useState<LoadingStatus>("idle");
  const [versionApiAvailable, setVersionApiAvailable] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState("");
  const [restoreNotice, setRestoreNotice] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [lastGeneration, setLastGeneration] =
    useState<EditorGenerationResponse | null>(null);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const versionHistoryRef = useRef<HTMLDetailsElement>(null);
  const mountedRef = useRef(false);
  const activeDocumentIdRef = useRef(document?.id ?? "");
  const documentContextRef = useRef({
    documentId: document?.id ?? "",
    token: 0,
  });
  const contentRequestRef = useRef(0);
  const layoutRequestRef = useRef(0);
  const matchRequestRef = useRef(0);
  const editorActionRequestRef = useRef(0);
  const editorActionAbortRef = useRef<AbortController | null>(null);

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
    };
  }, []);

  const selectedBlock = useMemo(
    () =>
      editorContent?.blocks.find(
        (block) => block.element_id === selectedElementId,
      ) ?? null,
    [editorContent, selectedElementId],
  );
  const sourceMatch = useMemo(
    () =>
      matches.find((match) => match.element_id === selectedElementId) ?? null,
    [matches, selectedElementId],
  );

  const dirty = useMemo(() => {
    if (!selectedBlock || !draft) return false;
    if (draft.text !== selectedBlock.text) return true;
    return JSON.stringify(draft.delta) !== JSON.stringify(selectedBlock.delta);
  }, [draft, selectedBlock]);

  const perDocumentDirty = useMemo(
    () =>
      matches.some(
        (match) =>
          includedElementIds.has(match.element_id) &&
          (targetReplacements[match.element_id] ?? match.text) !== match.text,
      ),
    [includedElementIds, matches, targetReplacements],
  );

  useEffect(() => {
    onDirtyChange(dirty || perDocumentDirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange, perDocumentDirty]);

  useEffect(() => {
    setRestoreNotice("");
    setRestoreError("");
    setRestoringVersionId("");
    setLocalError("");
    setPendingBlockSelection(null);
    setShowLayoutStructure(false);
  }, [document?.id]);

  useEffect(() => {
    if (!document) {
      setEditorContent(null);
      setContentStatus("idle");
      return;
    }

    const requestId = ++contentRequestRef.current;
    const controller = new AbortController();
    setContentStatus("loading");
    setLayoutView(null);
    setLayoutStatus("idle");
    setShowLayoutStructure(false);
    setSelectedElementId("");
    setDraft(null);
    setMatches([]);
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    setLastGeneration(null);

    async function loadContent() {
      let loaded = false;
      const requestedVersionId =
        versions?.document_id === document!.id
          ? versions.current_version_id
          : document!.current_version_id ?? document!.version_id;
      try {
        const response = await fetchEditorContent(
          requestedVersionId,
          controller.signal,
        );
        if (requestId !== contentRequestRef.current) return;
        setEditorContent(normaliseEditorContent(response, document!));
        loaded = true;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isUnavailable(error)) {
          if (requestId !== contentRequestRef.current) return;
          setLocalError(
            `${document!.name}: ${errorMessage(
              error,
              "Editor content could not be loaded.",
            )}`,
          );
        } else {
          try {
            const compatibleView =
              refreshToken === 0 &&
              fallbackView?.document_id === document!.id
                ? fallbackView
                : await fetchDocumentView(
                    requestedVersionId,
                    controller.signal,
                  );
            if (requestId !== contentRequestRef.current) return;
            setEditorContent(editorContentFromView(compatibleView, document!));
            loaded = true;
          } catch (fallbackError) {
            if (controller.signal.aborted) return;
            if (requestId !== contentRequestRef.current) return;
            setLocalError(
              `${document!.name}: ${errorMessage(
                fallbackError,
                "The structured editor could not open.",
              )}`,
            );
          }
        }
      } finally {
        if (
          !controller.signal.aborted &&
          requestId === contentRequestRef.current
        ) {
          setContentStatus(loaded ? "ready" : "error");
        }
      }
    }

    void loadContent();
    return () => controller.abort();
  }, [
    document?.id,
    document?.version_id,
    document?.current_version_id,
    fallbackView,
    refreshToken,
    versions?.current_version_id,
    versions?.document_id,
  ]);

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
      mode !== "edit"
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const card = findEditorBlockCard(searchTarget.element_id);
      const scrollContainer = card?.closest<HTMLElement>(
        ".editor-mode-scroll",
      );
      const stickyEditor = scrollContainer?.querySelector<HTMLElement>(
        ".quill-block-editor",
      );
      if (!card) return;

      if (scrollContainer) {
        const cardTop =
          scrollContainer.scrollTop +
          card.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top;
        const top = Math.max(
          0,
          cardTop - (stickyEditor?.offsetHeight ?? 0) - 18,
        );
        if (typeof scrollContainer.scrollTo === "function") {
          scrollContainer.scrollTo({ top, behavior: "auto" });
        } else {
          scrollContainer.scrollTop = top;
        }
      } else {
        card.scrollIntoView({ behavior: "auto", block: "center" });
      }

      try {
        card.focus({ preventScroll: true });
      } catch {
        card.focus();
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
    if (!document) {
      setVersions(null);
      setVersionStatus("idle");
      return;
    }
    const controller = new AbortController();
    setVersionStatus("loading");

    async function loadVersions() {
      let finalStatus: LoadingStatus = "ready";
      try {
        const response = await fetchDocumentVersions(
          document!.id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setVersions(normaliseVersions(response, document!));
        setVersionApiAvailable(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setVersions(fallbackVersions(document!, editorContent));
        setVersionApiAvailable(false);
        finalStatus = isMissingFeature(error) ? "ready" : "error";
      } finally {
        if (!controller.signal.aborted) {
          setVersionStatus(finalStatus);
        }
      }
    }

    void loadVersions();
    return () => controller.abort();
  }, [
    document?.id,
    document?.version_id,
    document?.current_version_id,
    editorContent?.version_id,
    refreshToken,
  ]);

  useEffect(() => {
    if (!document || mode !== "layout") return;
    const expectedVersion =
      document.current_version_id ?? document.version_id;
    if (
      layoutView &&
      layoutView.document_id === document.id &&
      layoutView.version_id === expectedVersion
    ) {
      return;
    }

    const requestId = ++layoutRequestRef.current;
    const controller = new AbortController();
    setLayoutStatus("loading");

    async function loadLayout() {
      let loaded = false;
      try {
        const response = await renderDocumentView(
          document!.id,
          controller.signal,
          expectedVersion,
        );
        if (requestId !== layoutRequestRef.current) return;
        setLayoutView(response);
        loaded = true;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requestId !== layoutRequestRef.current) return;
        try {
          const fallback = await fetchDocumentView(
            expectedVersion,
            controller.signal,
          );
          if (requestId !== layoutRequestRef.current) return;
          setLayoutView(fallback);
          loaded = true;
          setLocalError(
            `${document!.name}: Word layout was unavailable, so the selectable structured document is shown.`,
          );
        } catch (fallbackError) {
          if (controller.signal.aborted) return;
          if (requestId !== layoutRequestRef.current) return;
          setLocalError(
            `${document!.name}: ${errorMessage(
              fallbackError,
              "The layout preview could not open.",
            )}`,
          );
        }
      } finally {
        if (
          !controller.signal.aborted &&
          requestId === layoutRequestRef.current
        ) {
          setLayoutStatus(loaded ? "ready" : "error");
        }
      }
    }

    void loadLayout();
    return () => controller.abort();
  }, [
    document?.id,
    document?.version_id,
    document?.current_version_id,
    layoutRefresh,
    mode,
  ]);

  useEffect(() => {
    if (!selectedBlock || !selectedBlock.supported || selectedBlock.read_only) {
      setMatches([]);
      setMatchStatus("idle");
      setLegacyDiscovery(null);
      return;
    }

    const requestId = ++matchRequestRef.current;
    const controller = new AbortController();
    setMatchStatus("loading");
    setMatches([]);
    setLegacyDiscovery(null);

    async function loadMatches() {
      try {
        const [exactResult, similarResult] = await Promise.allSettled([
          fetchElementMatches(selectedBlock!.element_id, controller.signal),
          fetchSimilarMatches(selectedBlock!.element_id, controller.signal),
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
        for (const member of exactResult.value.link_group?.members ?? []) {
          const match = normaliseMatch(
            member,
            selectedBlock!.text,
            "exact",
          );
          if (match) {
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
          const comparison = await compareDocumentElements(
            selectedBlock!.element_id,
            candidateIds,
            controller.signal,
          );
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
      setIncludedElementIds(
        new Set(
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
          nextMatches.map((match) => [match.element_id, match.text]),
        ),
      );
      } catch (error) {
        if (
          !controller.signal.aborted &&
          requestId === matchRequestRef.current
        ) {
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
      });
    return () => controller.abort();
  }, [document?.name, selectedBlock?.element_id]);

  function setWorkspaceMode(nextMode: WorkspaceMode) {
    setMode(nextMode);
    window.requestAnimationFrame(() => {
      window.document
        .getElementById(`workspace-tab-${nextMode}`)
        ?.focus();
    });
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    modeIndex: number,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    let nextIndex = modeIndex;
    if (event.key === "ArrowLeft") {
      nextIndex =
        (modeIndex - 1 + WORKSPACE_MODES.length) % WORKSPACE_MODES.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (modeIndex + 1) % WORKSPACE_MODES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = WORKSPACE_MODES.length - 1;
    }
    setWorkspaceMode(WORKSPACE_MODES[nextIndex].id);
  }

  function focusEditorForElement(elementId: string) {
    const attemptFocus = () => {
      const editor = Array.from(
        window.document.querySelectorAll<HTMLElement>(
          ".quill-editor-host .ql-editor[data-editor-element-id]",
        ),
      ).find(
        (candidate) => candidate.dataset.editorElementId === elementId,
      );

      if (!editor) {
        return false;
      }

      editor.closest(".ql-container")?.classList.remove("ql-disabled");
      editor.classList.remove("ql-disabled");
      editor.setAttribute("contenteditable", "true");
      editor.removeAttribute("aria-disabled");
      editor.removeAttribute("aria-readonly");
      editor.removeAttribute("inert");
      editor.style.pointerEvents = "auto";

      try {
        editor.focus({ preventScroll: true });
      } catch {
        editor.focus();
      }

      return true;
    };

    /*
     * DOCSYNC_DIALOG_EDITOR_RECOVERY_V5
     *
     * The former native window.confirm blocked Electron's renderer and could
     * leave Quill's selection manager stale. The in-app dialog no longer
     * blocks the renderer, but the editor is still remounted and recovered
     * after either OK or Cancel.
     */
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        if (attemptFocus()) {
          return;
        }

        window.requestAnimationFrame(() => {
          attemptFocus();
        });
      });
    }, 0);
  }

  function selectElementById(
    elementId: string,
    options: {
      sourceVersionId?: string;
      sourceLabel?: string;
      skipDiscardConfirmation?: boolean;
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
      setShowLayoutStructure(false);
      setLayoutRefresh((current) => current + 1);
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
          "This Word element is preserved as read-only and cannot be opened in the structured editor."
        }`,
      );
      return;
    }

    selectBlock(block, options.skipDiscardConfirmation ?? false);
  }

  function activateSelectedBlock(block: EditorBlock) {
    matchRequestRef.current += 1;
    editorActionRequestRef.current += 1;
    editorActionAbortRef.current?.abort();
    editorActionAbortRef.current = null;

    setPendingBlockSelection(null);
    setSelectedElementId(block.element_id);
    setDraft({ delta: block.delta, text: block.text });
    setMatches([]);
    setMatchStatus("idle");
    setLegacyDiscovery(null);
    setIncludedElementIds(new Set());
    setTargetReplacements({});
    setEditMode("shared");
    setPreview(null);
    setPreviewOpen(false);
    setPreviewSignature("");
    setAction(null);
    setEditorResetToken((current) => current + 1);

    if (block.supported && !block.read_only) {
      setMode("edit");
      focusEditorForElement(block.element_id);
    }
  }

  function selectBlock(
    block: EditorBlock,
    skipDiscardConfirmation = false,
  ) {
    const changingBlock = block.element_id !== selectedElementId;

    if (!changingBlock) {
      if (block.supported && !block.read_only) {
        setMode("edit");
        setEditorResetToken((current) => current + 1);
        focusEditorForElement(block.element_id);
      }
      return;
    }

    if (
      !skipDiscardConfirmation &&
      (dirty || perDocumentDirty)
    ) {
      setPendingBlockSelection(block);
      return;
    }

    activateSelectedBlock(block);
  }

  function confirmPendingBlockSelection() {
    const block = pendingBlockSelection;
    if (!block) {
      return;
    }

    activateSelectedBlock(block);
  }

  function cancelPendingBlockSelection() {
    const currentElementId = selectedElementId;

    setPendingBlockSelection(null);
    setAction(null);

    if (!currentElementId) {
      return;
    }

    /*
     * Cancel keeps the current draft, but forces a fresh Quill instance so the
     * editor is immediately clickable after the confirmation dialog closes.
     */
    setMode("edit");
    setEditorResetToken((current) => current + 1);
    focusEditorForElement(currentElementId);
  }

  function handleDraftChange(nextDraft: QuillDraft) {
    setDraft(nextDraft);
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
      findEditorBlockCard(selectedBlock.element_id)?.focus();
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
    return {
      base_versions: Object.fromEntries(
        documentSet.documents.map((item) => [
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
      ? dirty || perDocumentDirty
      : dirty;
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
      !action,
  );
  const canGenerate = Boolean(
    canPreview &&
      preview &&
      previewSignature === operationSignature &&
      !action,
  );

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
    if (!operation || !selectedBlock || !canGenerate) return;
    editorActionAbortRef.current?.abort();
    const requestId = ++editorActionRequestRef.current;
    const controller = new AbortController();
    editorActionAbortRef.current = controller;
    setAction("generate");
    setLocalError("");
    try {
      let result: EditorGenerationResponse;
      try {
        result = await generateEditorEdit(
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
      if (
        controller.signal.aborted ||
        requestId !== editorActionRequestRef.current
      ) {
        return;
      }

      setLastGeneration(result);
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
        setLocalError(
          `${document?.name ?? "Document"} changed before generation. No version was created. The latest version is being reloaded.`,
        );
        setRefreshToken((current) => current + 1);
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
      setLayoutRefresh((current) => current + 1);
      setMode("edit");
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
            >
              <summary>
                Version history
                {versionStatus === "loading" ? "…" : ""}
              </summary>
              <div className="version-history-menu">
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

        <div
          className="workspace-mode-tabs"
          role="tablist"
          aria-label="Document workspace mode"
        >
          {WORKSPACE_MODES.map((item, index) => (
            <button
              id={`workspace-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              aria-controls={`workspace-panel-${item.id}`}
              tabIndex={mode === item.id ? 0 : -1}
              className={mode === item.id ? "active" : ""}
              onClick={() => setWorkspaceMode(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              key={item.id}
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>

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

        <div className="editor-mode-scroll">
          <section
            id="workspace-panel-layout"
            role="tabpanel"
            aria-labelledby="workspace-tab-layout"
            hidden={mode !== "layout"}
            className="editor-mode-panel layout-mode-panel"
          >
            <div className="mode-panel-heading">
              <div>
                <p className="eyebrow">Authoritative layout</p>
                <h2>
                  {showLayoutStructure || !layoutView?.pdf_url
                    ? "Select from document structure"
                    : "Read-only Word preview"}
                </h2>
                <p>
                  {showLayoutStructure || !layoutView?.pdf_url
                    ? "Choose a supported heading, paragraph, list item, or table cell to open its exact mapped block in Edit."
                    : "This view is rendered from the current DOCX. Choose Select from structure when you want to open a mapped element in the editor."}
                </p>
              </div>
              <div className="layout-heading-actions">
                {editorContent &&
                  (layoutStatus === "loading" || layoutView?.pdf_url) && (
                  <button
                    type="button"
                    className="primary-button layout-selection-toggle"
                    onClick={() =>
                      setShowLayoutStructure((current) => !current)
                    }
                    aria-pressed={showLayoutStructure}
                  >
                    {showLayoutStructure
                      ? "Show Word preview"
                      : "Select from structure"}
                  </button>
                  )}
                <button
                  type="button"
                  className="quiet-button"
                  disabled={layoutStatus === "loading"}
                  onClick={() => {
                    setLayoutView(null);
                    setShowLayoutStructure(false);
                    setLayoutRefresh((current) => current + 1);
                  }}
                >
                  Refresh layout
                </button>
              </div>
            </div>
            {layoutStatus === "loading" && !showLayoutStructure && (
              <div className="editor-loading-state" role="status">
                <span className="spinner" aria-hidden="true" />
                Microsoft Word is preparing the layout preview…
              </div>
            )}
            {layoutStatus === "error" && !editorContent && (
              <div className="editor-empty-state">
                <strong>Layout preview unavailable</strong>
                <p>
                  Use Edit for supported blocks or try Refresh layout after
                  closing any Word dialogue.
                </p>
              </div>
            )}
            {layoutStatus === "ready" &&
              layoutView?.pdf_url &&
              !showLayoutStructure && (
              <div className="layout-iframe-shell">
                <div className="render-notice">
                  <strong>Word layout</strong>
                  <span>
                    {layoutView.notice} This PDF remains read-only because no
                    reliable element-coordinate map is available. Use Select
                    from structure for safe direct selection.
                  </span>
                </div>
                <iframe
                  src={absoluteApiUrl(layoutView.pdf_url)}
                  title={`${document.name} Word layout preview`}
                />
              </div>
            )}
            {editorContent &&
              (showLayoutStructure ||
                (layoutStatus === "ready" &&
                  layoutView &&
                  !layoutView.pdf_url) ||
                layoutStatus === "error") && (
                <div className="layout-structured-fallback">
                  <div className="render-notice">
                    <strong>Selectable structure</strong>
                    <span>
                      {layoutStatus === "error"
                        ? "The rendered layout could not be loaded. Supported elements below still open their current mapped block safely in Edit."
                        : "Supported elements open the same stable block used by Edit and search. Read-only Word structures remain protected."}
                    </span>
                  </div>
                  {editorContent.blocks.map((block) => (
                    <LayoutFallbackBlock
                      block={block}
                      selected={block.element_id === selectedElementId}
                      onSelect={(selectedBlock) =>
                        selectElementById(selectedBlock.element_id, {
                          sourceVersionId:
                            layoutView?.version_id ??
                            editorContent.version_id,
                          sourceLabel: "Layout element",
                        })
                      }
                      key={block.element_id}
                    />
                  ))}
                </div>
              )}
          </section>

          <section
            id="workspace-panel-edit"
            role="tabpanel"
            aria-labelledby="workspace-tab-edit"
            hidden={mode !== "edit"}
            className="editor-mode-panel edit-mode-panel"
          >
            {/* DOCSYNC_QUILL_REMOUNT_V2 */}
            <QuillBlockEditor
              key={`${selectedBlock?.element_id ?? "empty"}:${editorResetToken}`}
              block={selectedBlock}
              value={draft?.delta ?? null}
              resetToken={editorResetToken}
              onChange={handleDraftChange}
            />
            <div className="structured-document-heading">
              <div>
                <p className="eyebrow">Stable block mapping</p>
                <h2>Document blocks</h2>
                <p>
                  Every card maps one-to-one to a stored Word element. Select
                  one supported card to edit it above.
                </p>
              </div>
              <div className="block-counts">
                <span>
                  <strong>{editorContent?.blocks.length ?? 0}</strong> total
                </span>
                <span>
                  <strong>{editorContent?.unsupported_count ?? 0}</strong>{" "}
                  read-only
                </span>
              </div>
            </div>
            {editorContent?.notice && (
              <div className="editor-content-notice" role="note">
                {editorContent.notice}
              </div>
            )}
            {editorContent?.unsupported.length ? (
              <details className="unsupported-diagnostics">
                <summary>
                  {editorContent.unsupported.length} preserved unsupported
                  structure
                  {editorContent.unsupported.length === 1 ? "" : "s"}
                </summary>
                <div>
                  {editorContent.unsupported.map((diagnostic, index) => (
                    <article
                      key={
                        diagnostic.id ??
                        `${diagnostic.element_type}-${index}`
                      }
                    >
                      <strong>
                        {diagnostic.element_type.replaceAll("_", " ")}
                      </strong>
                      {diagnostic.location && (
                        <small>{diagnostic.location}</small>
                      )}
                      <p>{diagnostic.reason}</p>
                      {diagnostic.text && <blockquote>{diagnostic.text}</blockquote>}
                    </article>
                  ))}
                </div>
              </details>
            ) : null}
            {contentStatus === "loading" && (
              <div className="editor-loading-state" role="status">
                <span className="spinner" aria-hidden="true" />
                Loading structured editor content…
              </div>
            )}
            {contentStatus === "error" && (
              <div className="editor-empty-state">
                <strong>Editor content unavailable</strong>
                <p>Choose another document or return home and reopen the set.</p>
              </div>
            )}
            {contentStatus === "ready" &&
              editorContent?.blocks.length === 0 && (
                <div className="editor-empty-state">
                  <strong>No supported body blocks</strong>
                  <p>
                    The document remains available in Layout. Unsupported Word
                    structures are preserved and are not rewritten.
                  </p>
                </div>
              )}
            <div className="editor-block-list">
              {editorContent?.blocks.map((block) => (
                <BlockCard
                  block={block}
                  selected={block.element_id === selectedElementId}
                  searchRange={
                    searchTarget?.document_id === document.id &&
                    searchTarget.element_id === block.element_id
                      ? {
                          start: searchTarget.match_start,
                          end: searchTarget.match_end,
                        }
                      : undefined
                  }
                  onSelect={selectBlock}
                  key={block.element_id}
                />
              ))}
            </div>
          </section>

          <section
            id="workspace-panel-compare"
            role="tabpanel"
            aria-labelledby="workspace-tab-compare"
            hidden={mode !== "compare"}
            className="editor-mode-panel compare-mode-panel"
          >
            <div className="mode-panel-heading">
              <div>
                <p className="eyebrow">Cross-document comparison</p>
                <h2>Exact and near matches</h2>
                <p>
                  Exact matches start included. Near matches require an
                  explicit decision before they can be changed.
                </p>
              </div>
              {selectedBlock && (
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setMode("edit")}
                >
                  Back to selected block
                </button>
              )}
            </div>
            {!selectedBlock ? (
              <div className="editor-empty-state">
                <strong>Select a block in Edit first</strong>
                <p>
                  Comparison is anchored to one stable source element so every
                  target remains traceable.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setMode("edit")}
                >
                  Go to Edit
                </button>
              </div>
            ) : !selectedBlock.supported || selectedBlock.read_only ? (
              <div className="editor-empty-state">
                <strong>This block is read-only</strong>
                <p>
                  {selectedBlock.unsupported_reason ??
                    "It cannot be safely compared or edited in this release."}
                </p>
              </div>
            ) : (
              <>
                <article className="compare-source-card">
                  <header>
                    <span>Source</span>
                    <strong>{document.name}</strong>
                    <small>{locationLabel(selectedBlock)}</small>
                  </header>
                  <p>{draft?.text ?? selectedBlock.text}</p>
                </article>
                {matchStatus === "loading" && (
                  <div className="editor-loading-state" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Finding exact and near matches…
                  </div>
                )}
                {matchStatus === "ready" &&
                  matches.filter(
                    (match) => match.match_type !== "source",
                  ).length === 0 && (
                    <div className="editor-empty-state">
                      <strong>No related blocks found</strong>
                      <p>
                        You can still use Whole-paragraph override for the
                        selected source block.
                      </p>
                    </div>
                  )}
                <div className="comparison-list">
                  {matches
                    .filter((match) => match.match_type !== "source")
                    .map((match) => {
                      const included = includedElementIds.has(match.element_id);
                      const nearUnavailable =
                        match.match_type === "near" &&
                        (match.decision !== "confirmed" ||
                          editMode === "shared");
                      return (
                        <article
                          className={`comparison-card ${match.match_type} ${
                            included ? "included" : "excluded"
                          }`}
                          key={match.element_id}
                        >
                          <header>
                            <label>
                              <input
                                type="checkbox"
                                checked={included}
                                disabled={nearUnavailable}
                                onChange={() => toggleTarget(match)}
                              />
                              <span>
                                <strong>{match.document_name}</strong>
                                <small>{locationLabel(match)}</small>
                              </span>
                            </label>
                            <span className={`match-kind ${match.match_type}`}>
                              {match.match_type === "exact"
                                ? "Exact · 100%"
                                : `Near · ${Math.round(
                                    match.similarity_score * 100,
                                  )}%`}
                            </span>
                          </header>
                          <p>
                            <DifferenceText spans={match.difference_spans} />
                          </p>
                          {match.match_type === "near" && (
                            <footer>
                              <span>
                                Decision:{" "}
                                <strong>{match.decision}</strong>
                              </span>
                              <div
                                role="group"
                                aria-label={`Decision for ${match.document_name}`}
                              >
                                <button
                                  type="button"
                                  className={
                                    match.decision === "confirmed"
                                      ? "active"
                                      : ""
                                  }
                                  onClick={() =>
                                    updateDecision(match, "confirmed")
                                  }
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  className={
                                    match.decision === "ignored"
                                      ? "active"
                                      : ""
                                  }
                                  onClick={() =>
                                    updateDecision(match, "ignored")
                                  }
                                >
                                  Ignore
                                </button>
                                <button
                                  type="button"
                                  className={
                                    match.decision === "removed"
                                      ? "active"
                                      : ""
                                  }
                                  onClick={() =>
                                    updateDecision(match, "removed")
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            </footer>
                          )}
                        </article>
                      );
                    })}
                </div>
              </>
            )}
          </section>
        </div>
      </section>

      <aside
        className="edit-sidebar editor-operation-sidebar"
        aria-labelledby="editor-operation-title"
      >
        {mode === "layout" ? (
          <>
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Layout diagnostics</span>
                <h2 id="editor-operation-title">Read-only source</h2>
              </div>
            </div>
            <div className="sidebar-empty">
              <span aria-hidden="true">W</span>
              <h3>Formatting stays authoritative</h3>
              <p>
                Layout is never edited in the browser. Quill writes supported
                changes back to targeted Word blocks while unrelated content
                remains intact.
              </p>
              <button
                type="button"
                className="quiet-button"
                onClick={() => setMode("edit")}
              >
                Switch to Edit
              </button>
            </div>
          </>
        ) : !selectedBlock ? (
          <>
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Controlled edit</span>
                <h2 id="editor-operation-title">Edit operation</h2>
              </div>
            </div>
            <div className="sidebar-empty">
              <span aria-hidden="true">T</span>
              <h3>Select one stable block</h3>
              <p>
                Choose a supported block in Edit to configure shared wording,
                per-document values, or a whole-paragraph override.
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
                <h2 id="editor-operation-title">Edit operation</h2>
              </div>
              <span className={`draft-status ${dirty ? "dirty" : ""}`}>
                {dirty || perDocumentDirty ? "Unsaved draft" : "No changes"}
              </span>
            </div>
            <div className="operation-sidebar-scroll">
              <div className="operation-source">
                <small>
                  Source · {document.name} · {locationLabel(selectedBlock)}
                </small>
                <p>{selectedBlock.text}</p>
              </div>

              <fieldset className="edit-mode-options">
                <legend>Edit mode</legend>
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
                      Use the Quill draft for checked exact matches. Near
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
                      Exact matches are safe by default. Confirm near matches
                      in Compare.
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
                <button
                  type="button"
                  className="quiet-button"
                  onClick={discardDraft}
                  disabled={!dirty && !perDocumentDirty}
                >
                  Discard draft
                </button>
                <button
                  ref={previewButtonRef}
                  type="button"
                  className="primary-button"
                  onClick={() => void handlePreview()}
                  disabled={!canPreview}
                >
                  {action === "preview" ? "Building preview…" : "Preview changes"}
                </button>
                <button
                  type="button"
                  className="generate-version-button"
                  onClick={() => void handleGenerate()}
                  disabled={!canGenerate}
                >
                  {action === "generate"
                    ? "Generating versions…"
                    : "Generate new versions"}
                </button>
              </div>
              <p className="generate-safety-copy">
                Preview never writes files. Generate is enabled only for the
                exact operation you reviewed.
              </p>

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
                <div className="generation-ready-state" role="status">
                  <strong>New versions created</strong>
                  <span>
                    The editor reloaded the current document mappings.
                  </span>
                  {lastGeneration.download_url && (
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

      {pendingBlockSelection && (
        <DiscardDraftDialog
          onConfirm={confirmPendingBlockSelection}
          onCancel={cancelPendingBlockSelection}
        />
      )}

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
