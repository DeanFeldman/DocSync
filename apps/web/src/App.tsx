import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  absoluteApiUrl,
  addDocumentsToSet,
  deleteDocumentSet,
  fetchDocumentSet,
  fetchDocumentSets,
  fetchEditorGeneration,
  fetchEditorGenerationJobs,
  removeDocumentFromSet,
  searchDocumentSet,
  uploadDocumentSet,
} from "./api";
import type {
  DocumentSetLibraryItem,
  DocumentSetResponse,
  DocumentSearchTarget,
  DocumentSummary,
  EditorGenerationResponse,
  FindReplaceOccurrence,
  GlobalSearchResponse,
  GlobalSearchResult,
} from "./types";

import docSyncLogo from "./assets/Docsync LOGO.png";
import DocumentExperience from "./DocumentExperience";
import FindReplacePanel from "./FindReplacePanel";
import {
  clearWorkspaceResourcesForDocument,
  clearWorkspaceResourcesForSet,
  clearWorkspaceViewStateForDocument,
  invalidateDocumentHeadResources,
} from "./workspaceResources";
import {
  applyTheme,
  initialThemePreference,
  persistThemePreference,
  resolveTheme,
  type AppTheme,
  type ThemePreference,
} from "./theme";

type BusyAction =
  | "upload"
  | "open-set"
  | "add-documents"
  | "remove-document"
  | "delete-set"
  | null;

type CreationStage =
  | "upload"
  | "validation"
  | "editor-preparation"
  | "workspace"
  | null;
type WorkspacePanel = "find" | "pending" | null;

type NewerVersionNotice = {
  document: DocumentSummary;
  jobId: string;
};

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elementLabel(elementType: string): string {
  if (elementType === "list_item") return "List item";
  if (elementType === "table_cell") return "Table cell";
  if (elementType === "table_paragraph") return "Table paragraph";
  return elementType.charAt(0).toUpperCase() + elementType.slice(1);
}

function mergeGenerationJobs(
  current: EditorGenerationResponse[],
  incoming: EditorGenerationResponse[],
): EditorGenerationResponse[] {
  const merged = new Map(current.map((job) => [job.generation_id, job]));
  for (const job of incoming) merged.set(job.generation_id, job);
  return Array.from(merged.values())
    .sort((left, right) =>
      (right.submitted_at ?? "").localeCompare(left.submitted_at ?? ""),
    )
    .slice(0, 20);
}

type ElementLocation = {
  element_type: string;
  paragraph_index: number;
  table_index?: number;
  row_index?: number;
  column_index?: number;
};

function elementLocation(element: ElementLocation): string {
  if (
    ["table_cell", "table_paragraph"].includes(element.element_type) &&
    element.table_index !== undefined &&
    element.row_index !== undefined &&
    element.column_index !== undefined
  ) {
    return `Table ${element.table_index + 1} · Row ${element.row_index + 1} · Column ${
      element.column_index + 1
    }${
      element.element_type === "table_paragraph"
        ? ` · Paragraph ${element.paragraph_index + 1}`
        : ""
    }`;
  }

  return `${elementLabel(element.element_type)} · Paragraph ${
    element.paragraph_index + 1
  }`;
}

function readableDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved locally";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => initialThemePreference());
  const [theme, setTheme] = useState<AppTheme>(() => resolveTheme(initialThemePreference()));
const [setName, setSetName] = useState("");
const [setNameTouched, setSetNameTouched] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [documentSet, setDocumentSet] = useState<DocumentSetResponse | null>(null);
  const [savedSets, setSavedSets] = useState<DocumentSetLibraryItem[]>([]);
  const [savedSetQuery, setSavedSetQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [openingSetId, setOpeningSetId] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([]);
  const [globalSearchSummary, setGlobalSearchSummary] = useState<
    Pick<GlobalSearchResponse, "result_count" | "document_count" | "truncated">
  >({
    result_count: 0,
    document_count: 0,
    truncated: false,
  });
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchRefreshToken, setGlobalSearchRefreshToken] = useState(0);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [documentSearchTarget, setDocumentSearchTarget] =
    useState<DocumentSearchTarget | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [creationStage, setCreationStage] = useState<CreationStage>(null);
  const [error, setError] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>(null);
  const [pendingChangeCount, setPendingChangeCount] = useState(0);
  const [generationJobs, setGenerationJobs] = useState<
    EditorGenerationResponse[]
  >([]);
  const [newerVersionNotice, setNewerVersionNotice] =
    useState<NewerVersionNotice | null>(null);
  const [deferredDocumentUpdates, setDeferredDocumentUpdates] = useState<
    Record<string, DocumentSummary>
  >({});
  const addDocumentsInputRef = useRef<HTMLInputElement>(null);
  const globalSearchInputRef = useRef<HTMLInputElement>(null);
  const globalSearchContainerRef = useRef<HTMLDivElement>(null);
  const documentSearchRequestRef = useRef(0);
  const activeDocumentIdRef = useRef(activeDocumentId);
  const handledGenerationJobsRef = useRef(new Set<string>());

  activeDocumentIdRef.current = activeDocumentId;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const updateTheme = () => setTheme(resolveTheme(themePreference));
    updateTheme();
    if (themePreference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", updateTheme);
    return () => media.removeEventListener("change", updateTheme);
  }, [themePreference]);

  useEffect(() => {
    document.body.classList.toggle("workspace-open", Boolean(documentSet));
    return () => document.body.classList.remove("workspace-open");
  }, [documentSet?.id]);

  function selectThemePreference(preference: ThemePreference) {
    persistThemePreference(preference);
    setThemePreference(preference);
  }

  const filteredSavedSets = useMemo(() => {
    const query = savedSetQuery.trim().toLocaleLowerCase();
    if (!query) return savedSets;

    return savedSets.filter((item) =>
      item.name.toLocaleLowerCase().includes(query),
    );
  }, [savedSetQuery, savedSets]);

  const activeDocument = useMemo(
    () => documentSet?.documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documentSet],
  );

  const globalSearchScopeKey = useMemo(
    () =>
      documentSet?.documents
        .map(
          (document) =>
            `${document.id}:${document.current_version_id ?? document.version_id}`,
        )
        .join("|") ?? "",
    [documentSet],
  );

  const globalSearchGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        documentId: string;
        documentName: string;
        results: GlobalSearchResult[];
      }
    >();
    for (const result of globalSearchResults) {
      const group = groups.get(result.document_id) ?? {
        documentId: result.document_id,
        documentName: result.document_name,
        results: [],
      };
      group.results.push(result);
      groups.set(result.document_id, group);
    }
    return Array.from(groups.values());
  }, [globalSearchResults]);

  const setNameError =
  setNameTouched && setName.trim() === ""
    ? "Enter a document-set name."
    : "";

  useEffect(() => {
    let cancelled = false;

    async function loadLibrary() {
      setLibraryLoading(true);
      setLibraryError("");
      try {
        const response = await fetchDocumentSets();
        if (!cancelled) setSavedSets(response.document_sets);
      } catch (caught) {
        if (!cancelled) {
          setLibraryError(
            caught instanceof Error ? caught.message : "Saved workspaces could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    }

    void loadLibrary();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!documentSet?.id) return;
    const controller = new AbortController();
    void fetchEditorGenerationJobs(documentSet.id, controller.signal)
      .then((response) => {
        const relevant = response.jobs.filter((job) => {
          if (["completed", "failed", "interrupted"].includes(job.status)) {
            handledGenerationJobsRef.current.add(job.generation_id);
            return false;
          }
          return true;
        });
        setGenerationJobs((current) =>
          mergeGenerationJobs(current, relevant),
        );
      })
      .catch(() => {
        // The workspace remains usable if historical job status is unavailable.
      });
    return () => controller.abort();
  }, [documentSet?.id]);

  const activeGenerationJobKey = generationJobs
    .filter((job) => ["queued", "processing"].includes(job.status))
    .map((job) => job.generation_id)
    .sort()
    .join("|");

  useEffect(() => {
    const activeJobIds = activeGenerationJobKey
      ? activeGenerationJobKey.split("|")
      : [];
    if (!activeJobIds.length) return;
    let cancelled = false;
    const controller = new AbortController();

    async function poll() {
      const results = await Promise.allSettled(
        activeJobIds.map((jobId) =>
          fetchEditorGeneration(jobId, controller.signal),
        ),
      );
      if (cancelled) return;
      const updates = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (updates.length) {
        setGenerationJobs((current) =>
          mergeGenerationJobs(current, updates),
        );
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [activeGenerationJobKey]);

  useEffect(() => {
    for (const job of generationJobs) {
      if (["queued", "processing"].includes(job.status)) continue;
      if (handledGenerationJobsRef.current.has(job.generation_id)) continue;
      handledGenerationJobsRef.current.add(job.generation_id);
      handleGenerationJobSettled(job);
    }
  }, [generationJobs]);


  useEffect(() => {
    const query = globalSearchQuery.trim();
    if (!documentSet || query.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearchSummary({
        result_count: 0,
        document_count: 0,
        truncated: false,
      });
      setGlobalSearchLoading(false);
      setGlobalSearchOpen(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setGlobalSearchResults([]);
    setGlobalSearchSummary({
      result_count: 0,
      document_count: 0,
      truncated: false,
    });
    setGlobalSearchLoading(true);
    const timeout = window.setTimeout(async () => {
      try {
        const response = await searchDocumentSet(
          documentSet.id,
          query,
          controller.signal,
        );
        if (!cancelled) {
          setGlobalSearchResults(response.results);
          setGlobalSearchSummary({
            result_count: response.result_count,
            document_count: response.document_count,
            truncated: response.truncated,
          });
          setGlobalSearchOpen(true);
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (!cancelled) {
          setGlobalSearchResults([]);
          setGlobalSearchSummary({
            result_count: 0,
            document_count: 0,
            truncated: false,
          });
          setError(
            caught instanceof Error ? caught.message : "The document-set search failed.",
          );
        }
      } finally {
        if (!cancelled) setGlobalSearchLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    documentSet?.id,
    globalSearchQuery,
    globalSearchRefreshToken,
    globalSearchScopeKey,
  ]);

  useEffect(() => {
    if (!window.history.state?.view) {
      window.history.replaceState({ view: "home" }, "");
    }

    function handlePopState() {
      if (window.history.state?.view !== "workspace") {
        resetWorkspace(false);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleGenerationQueued(job: EditorGenerationResponse) {
    handledGenerationJobsRef.current.delete(job.generation_id);
    setGenerationJobs((current) => mergeGenerationJobs(current, [job]));
  }

  function handleGenerationJobSettled(job: EditorGenerationResponse) {
    if (job.status !== "completed") {
      return;
    }

    const updated = job.document_set;
    const documentUpdates = job.document_updates ?? updated?.documents ?? [];
    const affectedIds = new Set(
      job.affected_document_ids ??
        job.versions?.map((version) => version.document_id) ??
        [],
    );
    const updatedActiveDocument = documentUpdates.find(
      (item) => item.id === activeDocumentIdRef.current && affectedIds.has(item.id),
    );
    const currentActiveDocument = documentSet?.documents.find(
      (item) => item.id === activeDocumentIdRef.current,
    );
    if (
      updatedActiveDocument &&
      currentActiveDocument &&
      editorDirty &&
      (updatedActiveDocument.current_version_id ?? updatedActiveDocument.version_id) !==
        (currentActiveDocument.current_version_id ?? currentActiveDocument.version_id)
    ) {
      setDeferredDocumentUpdates((current) => ({
        ...current,
        [updatedActiveDocument.id]: updatedActiveDocument,
      }));
      setNewerVersionNotice({
        document: updatedActiveDocument,
        jobId: job.generation_id,
      });
    }

    if (updated || documentUpdates.length) {
      const workspaceId = updated?.id ?? documentSet?.id;
      if (!workspaceId) return;
      for (const documentId of affectedIds) {
        invalidateDocumentHeadResources(workspaceId, documentId);
      }
      setDocumentSet((current) => {
        if (!current || current.id !== workspaceId) return current;
        const updatedById = new Map(
          documentUpdates.map((item) => [item.id, item]),
        );
        return {
          ...(updated ?? current),
          documents: current.documents.map((item) => {
            const replacement = updatedById.get(item.id) ?? item;
            return editorDirty && item.id === activeDocumentIdRef.current && affectedIds.has(item.id)
              ? item
              : replacement;
          }),
        };
      });
      setSavedSets((current) =>
        current.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                name: updated?.name ?? item.name,
                document_count:
                  updated?.documents.length ?? item.document_count,
                edit_count: item.edit_count + 1,
              }
            : item,
        ),
      );
      setGlobalSearchRefreshToken((current) => current + 1);
    }

  }

  function openNewerVersion(notice: NewerVersionNotice) {
    setDocumentSet((current) =>
      current
        ? {
            ...current,
            documents: current.documents.map((item) =>
              item.id === notice.document.id ? notice.document : item,
            ),
          }
        : current,
    );
    setDeferredDocumentUpdates((current) => {
      const next = { ...current };
      delete next[notice.document.id];
      return next;
    });
    setNewerVersionNotice(null);
    setEditorDirty(false);
  }

  function resetWorkspace(updateHistory = true) {
    if (editorDirty && documentSet && activeDocumentId) {
      clearWorkspaceViewStateForDocument(
        documentSet.id,
        activeDocumentId,
      );
    }

    if (
      updateHistory &&
      documentSet &&
      window.history.state?.view === "workspace"
    ) {
      window.history.back();
      return;
    }

    setDocumentSet(null);
    setActiveDocumentId("");
    setFiles([]);
    setGlobalSearchQuery("");
    setGlobalSearchResults([]);
    setGlobalSearchSummary({
      result_count: 0,
      document_count: 0,
      truncated: false,
    });
    setGlobalSearchOpen(false);
    setDocumentSearchTarget(null);
    setEditorDirty(false);
    setNewerVersionNotice(null);
    setDeferredDocumentUpdates({});
    setError("");
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
    setError("");
  }

  function openWorkspace(workspace: DocumentSetResponse) {
    if (workspace.documents.some((document) => !document.version_id)) {
      throw new Error(
        "The local document service is an older DocumentSync version. Close and reopen the application, then try again.",
      );
    }

    const firstDocument = workspace.documents[0] ?? null;

    if (
      window.history.state?.view !== "workspace" ||
      window.history.state?.documentSetId !== workspace.id
    ) {
      window.history.pushState(
        { view: "workspace", documentSetId: workspace.id },
        "",
      );
    }

    setDocumentSet(workspace);
    setActiveDocumentId(firstDocument?.id ?? "");
    setGlobalSearchQuery("");
    setGlobalSearchResults([]);
    setGlobalSearchSummary({
      result_count: 0,
      document_count: 0,
      truncated: false,
    });
    setGlobalSearchOpen(false);
    setDocumentSearchTarget(null);
    setEditorDirty(false);
    setNewerVersionNotice(null);
    setDeferredDocumentUpdates({});
  }

async function handleUpload(event: FormEvent) {
  event.preventDefault();

  setSetNameTouched(true);

  const trimmedSetName = setName.trim();

  if (!trimmedSetName) {
    return;
  }

  setError("");
  setBusyAction("upload");
  setCreationStage("upload");
  const validationTimer = window.setTimeout(
    () => setCreationStage("validation"),
    250,
  );
  const editorPreparationTimer = window.setTimeout(
    () => setCreationStage("editor-preparation"),
    900,
  );

  try {
    const uploaded = await uploadDocumentSet(trimmedSetName, files);
      setCreationStage("workspace");
      openWorkspace(uploaded);
      setFiles([]);
      setSavedSets((current) => [
        {
          id: uploaded.id,
          name: uploaded.name,
          created_at: uploaded.created_at,
          document_count: uploaded.documents.length,
          edit_count: 0,
        },
        ...current.filter((item) => item.id !== uploaded.id),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The upload failed.");
    } finally {
      window.clearTimeout(validationTimer);
      window.clearTimeout(editorPreparationTimer);
      setCreationStage(null);
      setBusyAction(null);
    }
  }

  async function openSavedWorkspace(item: DocumentSetLibraryItem) {
    setError("");
    setBusyAction("open-set");
    setOpeningSetId(item.id);
    try {
      openWorkspace(await fetchDocumentSet(item.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The saved workspace could not open.");
    } finally {
      setOpeningSetId("");
      setBusyAction(null);
    }
  }


  async function handleDeleteDocumentSet(item: DocumentSetLibraryItem) {
    const confirmed = window.confirm(
      `Delete "${item.name}" permanently?\n\nThis removes the saved set and its local files. This cannot be undone.`,
    );
    if (!confirmed) return;

    setError("");
    setBusyAction("delete-set");
    try {
      await deleteDocumentSet(item.id);
      clearWorkspaceResourcesForSet(item.id);
      setSavedSets((current) => current.filter((saved) => saved.id !== item.id));
      if (documentSet?.id === item.id) {
        window.history.replaceState({ view: "home" }, "");
        resetWorkspace(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document set could not be deleted.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAddDocuments(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!documentSet || selectedFiles.length === 0) return;

    setError("");
    setBusyAction("add-documents");
    try {
      const updated = await addDocumentsToSet(documentSet.id, selectedFiles);
      setDocumentSet(updated);
      setSavedSets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? { ...item, document_count: updated.documents.length }
            : item,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The documents could not be added.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRemoveDocument(document: DocumentSummary) {
    if (!documentSet) return;
    const confirmed = window.confirm(
      `Remove "${document.name}" from this set?\n\nThe set must retain at least two documents.`,
    );
    if (!confirmed) return;

    setError("");
    setBusyAction("remove-document");
    try {
      const updated = await removeDocumentFromSet(documentSet.id, document.id);
      setDocumentSet(updated);
      setDocumentSearchTarget(null);
      setSavedSets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? { ...item, document_count: updated.documents.length }
            : item,
        ),
      );
      clearWorkspaceResourcesForDocument(documentSet.id, document.id);

      if (activeDocumentId === document.id) {
        const nextDocument = updated.documents[0] ?? null;
        setActiveDocumentId(nextDocument?.id ?? "");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document could not be removed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function openGlobalSearchResult(result: GlobalSearchResult) {
    if (!documentSet) return;
    const targetDocument = documentSet.documents.find(
      (document) => document.id === result.document_id,
    );
    if (!targetDocument) return;

    setGlobalSearchOpen(false);
    await openDocument(targetDocument, result);
  }

  function handleGlobalSearchResultKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      setGlobalSearchOpen(false);
      globalSearchInputRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const buttons = Array.from(
      globalSearchContainerRef.current?.querySelectorAll<HTMLButtonElement>(
        ".global-search-result",
      ) ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(event.currentTarget);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    }
    buttons[nextIndex]?.focus();
  }

  async function openDocument(
    document: DocumentSummary,
    searchResult: GlobalSearchResult | null = null,
  ) {
    if (editorDirty && documentSet && activeDocumentId) {
      clearWorkspaceViewStateForDocument(
        documentSet.id,
        activeDocumentId,
      );
    }

    const deferredDocument = deferredDocumentUpdates[document.id];
    if (deferredDocument) {
      setDocumentSet((current) =>
        current
          ? {
              ...current,
              documents: current.documents.map((item) =>
                item.id === deferredDocument.id ? deferredDocument : item,
              ),
            }
          : current,
      );
      setDeferredDocumentUpdates((current) => {
        const next = { ...current };
        delete next[document.id];
        return next;
      });
    }

    setEditorDirty(false);
    setError("");
    setDocumentSearchTarget(
      searchResult
        ? {
            request_id: ++documentSearchRequestRef.current,
            document_id: searchResult.document_id,
            element_id: searchResult.element_id,
            query: globalSearchQuery.trim(),
            occurrence_index: searchResult.occurrence_index,
            match_start: searchResult.match_start,
            match_end: searchResult.match_end,
          }
        : null,
    );
    setActiveDocumentId((deferredDocument ?? document).id);
  }

  function handleEditorGenerated(result: EditorGenerationResponse) {
    const updated = result.document_set;
    setDocumentSearchTarget(null);
    if (updated) {
      for (const changedVersion of result.versions ?? []) {
        invalidateDocumentHeadResources(updated.id, changedVersion.document_id);
      }
      setDocumentSet(updated);
      setSavedSets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                name: updated.name,
                document_count: updated.documents.length,
                edit_count: item.edit_count + 1,
              }
            : item,
        ),
      );
    }
    setEditorDirty(false);
  }

const canUpload = files.length >= 2 && !busyAction;
  return (
    <div className={`app-shell ${documentSet ? "workspace-mode" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="DocSync home">
          <img
            className="brand-logo"
            src={docSyncLogo}
            alt="DocSync"
          />
        </a>

        {/* <p className="hero-text">
                View uploaded Word documents in the browser, choose an exact shared element,
                review every target, and create new versions without touching the originals.
              </p> */}
{/*
              <p className="hero-copy">
                <h1> DocSync</h1>

              </p> */}

        <div className="topbar-actions">
          <span
            className="version-badge"
            aria-label={`DocSync version ${__DOCSYNC_VERSION__}`}
          >
            v{__DOCSYNC_VERSION__}
          </span>
          <details className="theme-selector">
            <summary aria-label="Choose appearance"><span className="theme-toggle-icon" aria-hidden="true">{themePreference === "dark" ? "☾" : themePreference === "light" ? "☀" : "▣"}</span> Appearance</summary>
            <div className="theme-selector-menu" role="menu" aria-label="Appearance">
              <strong>Appearance</strong>
              {(["system", "light", "dark"] as ThemePreference[]).map((preference) => (
                <button key={preference} type="button" className={themePreference === preference ? "selected" : ""} onClick={() => selectThemePreference(preference)} role="menuitemradio" aria-checked={themePreference === preference}>
                  {themePreference === preference ? "✓ " : ""}{preference === "system" ? "System" : preference[0].toUpperCase() + preference.slice(1)}
                </button>
              ))}
            </div>
          </details>
          {documentSet && (
            <button type="button" className="quiet-button" onClick={() => resetWorkspace()}>
              Home
            </button>
          )}
        </div>
      </header>

      {!documentSet ? (
        <main id="top">
          {/* <section className="hero"> */}
            {/* <div className="hero-copy"> */}
              {/* <p className="eyebrow">Open. Select. Synchronise safely.</p> */}
              {/* <h1>Edit shared content in the documents you already use.</h1> */}
              {/* <p className="hero-text">
                View uploaded Word documents in the browser, choose an exact shared element,
                review every target, and create new versions without touching the originals.
              </p> */}
            {/* </div>
            <div className="workflow-card" aria-label="Document editing workflow">
              <div><span>1</span><p><strong>Open</strong><small>Scroll through each document</small></p></div>
              <div><span>2</span><p><strong>Select</strong><small>Choose recognised content</small></p></div>
              <div><span>3</span><p><strong>Review</strong><small>Confirm every exact match</small></p></div>
            </div> */}
          {/* </section> */}

          <section className="upload-workspace" aria-labelledby="upload-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Start a workspace</p>
                <h2 id="upload-title">Upload a related document set</h2>
              </div>
              <p>Choose 2–20 DOCX files.</p>
            </div>

            {error && (
              <ErrorAlert message={error} onDismiss={() => setError("")} />
            )}

<form
  className="upload-panel"
  onSubmit={handleUpload}
  noValidate
>
              <label className="field">
                <span>Document-set name</span>

                <input
                  value={setName}
                  onChange={(event) => {
                    setSetName(event.target.value);
                    setSetNameTouched(true);
                  }}
                  onBlur={() => setSetNameTouched(true)}
                  maxLength={200}
                  placeholder="Example: Building agreements"
                  aria-required="true"
                  aria-invalid={Boolean(setNameError)}
                  aria-describedby={setNameError ? "set-name-error" : undefined}
                />

                {setNameError && (
                  <small
                    id="set-name-error"
                    className="field-error"
                    role="alert"
                  >
                    {setNameError}
                  </small>
                )}

                <div className="workspace-name-preview">
                  <span>Workspace preview</span>
                  <strong>
                    {setName.trim() || "Your document-set name will appear here"}
                  </strong>
                </div>
              </label>

              <label className="file-drop">
                <input
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  multiple
                  onChange={handleFiles}
                />
                <span className="file-icon" aria-hidden="true">DOCX</span>
                <strong>Select Word documents</strong>
                <small>Files stay private to the local DocumentSync workspace.</small>
              </label>
              {files.length > 0 && (
                <div className="selected-files" aria-live="polite">
                  <div className="selected-files-header">
                    <strong>{files.length} file{files.length === 1 ? "" : "s"} selected</strong>
                    <button type="button" className="text-button" onClick={() => setFiles([])}>
                      Clear
                    </button>
                  </div>
                  <ul>
                    {files.map((file) => (
                      <li key={`${file.name}-${file.lastModified}`}>
                        <span>{file.name}</span><small>{readableBytes(file.size)}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button className="primary-button" type="submit" disabled={!canUpload}>
                {busyAction === "upload" ? "Preparing workspace…" : "Upload and open workspace"}
              </button>
              {busyAction === "upload" && creationStage && (
                <CreationProgress stage={creationStage} />
              )}
            </form>

            <section className="saved-library" aria-labelledby="saved-library-title">
              <div className="saved-library-heading">
                <div>
                  <p className="eyebrow">Continue working</p>
                  <h2 id="saved-library-title">Saved workspaces</h2>
                  <p className="saved-library-description">
                    Reopen a document set stored on this computer without uploading it again.
                  </p>
                </div>

                <label className="saved-set-search">
                  <span className="sr-only">Search saved workspaces</span>
                  <input
                    type="search"
                    value={savedSetQuery}
                    onChange={(event) => setSavedSetQuery(event.target.value)}
                    placeholder="Search saved workspaces"
                  />
                  {savedSetQuery && (
                    <button
                      type="button"
                      onClick={() => setSavedSetQuery("")}
                      aria-label="Clear saved workspace search"
                    >
                      ×
                    </button>
                  )}
                </label>
              </div>

              {libraryLoading ? (
                <div className="saved-library-state" role="status">Loading saved workspaces…</div>
              ) : libraryError ? (
                <div className="saved-library-state error" role="alert">
                  <strong>Saved workspaces are unavailable.</strong>
                  <span>{libraryError}</span>
                </div>
              ) : savedSets.length === 0 ? (
                <div className="saved-library-state">
                  <strong>No saved workspaces yet.</strong>
                  <span>Your first uploaded document set will appear here automatically.</span>
                </div>
              ) : filteredSavedSets.length === 0 ? (
                <div className="saved-library-state">
                  <strong>No matching workspaces.</strong>
                  <span>Try a different workspace name.</span>
                </div>
              ) : (
                <div className="saved-workspace-grid">
                  {filteredSavedSets.map((item) => (
                    <article className="saved-workspace-card" key={item.id}>
                      <button
                        type="button"
                        className="saved-workspace-main"
                        onClick={() => void openSavedWorkspace(item)}
                        disabled={Boolean(busyAction)}
                      >
                        <span className="saved-workspace-icon" aria-hidden="true">W</span>
                        <span className="saved-workspace-copy">
                          <strong>{item.name}</strong>
                          <small>Saved {readableDate(item.created_at)}</small>
                          <span className="saved-workspace-stats">
                            {item.document_count} document{item.document_count === 1 ? "" : "s"}
                            <i aria-hidden="true">·</i>
                            {item.edit_count} edit{item.edit_count === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="saved-workspace-open">
                          {busyAction === "open-set" && openingSetId === item.id
                            ? "Opening…"
                            : "Open workspace"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="saved-workspace-delete"
                        onClick={() => void handleDeleteDocumentSet(item)}
                        disabled={Boolean(busyAction)}
                        aria-label={`Delete ${item.name}`}
                      >
                        Delete
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        </main>
      ) : (
        <main id="top" className="phase-two-main">
          <section className="workspace-heading" aria-labelledby="workspace-title">
            <div>
              <p className="eyebrow">Document set</p>
              <h1 id="workspace-title">{documentSet.name}</h1>
            </div>

            <div className="workspace-heading-actions">
              <div
                className="global-set-search"
                role="search"
                ref={globalSearchContainerRef}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    setGlobalSearchOpen(false);
                  }
                }}
              >
                <label htmlFor="global-document-search" className="sr-only">
                  Search all documents in this set
                </label>
                <input
                  id="global-document-search"
                  type="search"
                  ref={globalSearchInputRef}
                  value={globalSearchQuery}
                  onChange={(event) => setGlobalSearchQuery(event.target.value)}
                  onFocus={() => setGlobalSearchOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setGlobalSearchOpen(false);
                    } else if (event.key === "ArrowDown") {
                      const firstResult =
                        globalSearchContainerRef.current?.querySelector<HTMLButtonElement>(
                          ".global-search-result",
                        );
                      if (firstResult) {
                        event.preventDefault();
                        firstResult.focus();
                      }
                    }
                  }}
                  placeholder="Search all documents"
                  aria-expanded={globalSearchOpen}
                  aria-controls="global-search-results"
                />
                {globalSearchLoading && <span className="global-search-status">Searching…</span>}
                {globalSearchOpen && globalSearchQuery.trim().length >= 2 && (
                  <div
                    id="global-search-results"
                    className="global-search-results"
                    aria-live="polite"
                    aria-label="Search results across all documents"
                  >
                    {globalSearchLoading ? (
                      <div className="global-search-empty">
                        Searching every current document…
                      </div>
                    ) : globalSearchResults.length === 0 ? (
                      <div className="global-search-empty">
                        No occurrences in this document set.
                      </div>
                    ) : (
                      <>
                        <header className="global-search-summary">
                          <div>
                            <strong>
                              {globalSearchSummary.result_count}{" "}
                              {globalSearchSummary.result_count === 1
                                ? "occurrence"
                                : "occurrences"}
                            </strong>
                            <span>
                              across {globalSearchSummary.document_count}{" "}
                              {globalSearchSummary.document_count === 1
                                ? "document"
                                : "documents"}
                            </span>
                          </div>
                          <small>All current versions</small>
                        </header>
                        {globalSearchGroups.map((group) => (
                          <section
                            className="global-search-document-group"
                            key={group.documentId}
                            aria-label={`${group.documentName}: ${group.results.length} occurrences`}
                          >
                            <header>
                              <strong>{group.documentName}</strong>
                              <span>{group.results.length}</span>
                            </header>
                            <div>
                              {group.results.map((result) => (
                                <button
                                  type="button"
                                  className="global-search-result"
                                  key={result.result_id}
                                  onClick={() =>
                                    void openGlobalSearchResult(result)
                                  }
                                  onKeyDown={
                                    handleGlobalSearchResultKeyDown
                                  }
                                  aria-label={`Open occurrence ${result.occurrence_index} in ${result.document_name}, ${elementLocation(result)}`}
                                >
                                  <span className="global-search-snippet">
                                    {result.context_before}
                                    <mark>{result.matched_text}</mark>
                                    {result.context_after}
                                  </span>
                                  <small>{elementLocation(result)}</small>
                                </button>
                              ))}
                            </div>
                          </section>
                        ))}
                        {globalSearchSummary.truncated && (
                          <div className="global-search-warning">
                            Some results were not returned by the document
                            service. Refine the search to see them.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              <button type="button" className="toolbar-button" onClick={() => setWorkspacePanel("find")}>Find &amp; Replace</button>
              <button type="button" className="toolbar-button pending-batch-button" onClick={() => setWorkspacePanel("pending")}>Pending changes <strong>{pendingChangeCount}</strong></button>

              <div className="set-summary">
                <strong>{documentSet.documents.length}</strong><span>docs ·</span>
                <strong>{documentSet.link_group_count ?? documentSet.link_groups.length}</strong><span>groups</span>
              </div>

              <button
                type="button"
                className="danger-button"
                onClick={() =>
                  void handleDeleteDocumentSet({
                    id: documentSet.id,
                    name: documentSet.name,
                    created_at: documentSet.created_at,
                    document_count: documentSet.documents.length,
                    edit_count:
                      savedSets.find((item) => item.id === documentSet.id)?.edit_count ?? 0,
                  })
                }
                disabled={Boolean(busyAction)}
              >
                Delete set
              </button>
            </div>
          </section>

          {error && (
            <ErrorAlert message={error} onDismiss={() => setError("")} />
          )}

          <FindReplacePanel
            documentSet={documentSet}
            activeDocumentId={activeDocumentId}
            panel={workspacePanel}
            onPanelChange={setWorkspacePanel}
            onPendingCountChange={setPendingChangeCount}
            onGenerationQueued={handleGenerationQueued}
            onOpenOccurrence={(occurrence: FindReplaceOccurrence) => {
              const target = documentSet.documents.find(
                (item) => item.id === occurrence.document_id,
              );
              if (!target) return;
              void openDocument(
                target,
                occurrence.revision_id
                  ? {
                      result_id: occurrence.result_id,
                      element_id: occurrence.element_id ?? occurrence.segment_id,
                      document_id: occurrence.document_id,
                      document_name: occurrence.document_name,
                      version_id: occurrence.version_id,
                      paragraph_index: Number(
                        occurrence.location.paragraph_index ?? 0,
                      ),
                      element_type: occurrence.structure_type as GlobalSearchResult["element_type"],
                      text: `${occurrence.context_before}${occurrence.matched_text}${occurrence.context_after}`,
                      occurrence_index: 1,
                      match_start: occurrence.match_start,
                      match_end: occurrence.match_end,
                      context_before: occurrence.context_before,
                      matched_text: occurrence.matched_text,
                      context_after: occurrence.context_after,
                    }
                  : null,
              );
            }}
          />

          {newerVersionNotice &&
            newerVersionNotice.document.id === activeDocumentId && (
              <section className="newer-version-notice" role="status" aria-live="polite">
                <div>
                  <strong>A newer version of this document is available.</strong>
                  <span>Your current view and any draft were left unchanged.</span>
                </div>
                <div>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => openNewerVersion(newerVersionNotice)}
                  >
                    Open new version
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setNewerVersionNotice(null)}
                  >
                    Continue viewing current version
                  </button>
                </div>
              </section>
            )}

          <div className="document-workspace">
            <aside className="file-rail" aria-labelledby="files-title">
              <div className="rail-heading">
                <span>Files</span>
                <div className="rail-heading-actions">
                  <small>{documentSet.documents.length}</small>
                  <button
                    type="button"
                    className="rail-add-button"
                    onClick={() => addDocumentsInputRef.current?.click()}
                    disabled={Boolean(busyAction) || documentSet.documents.length >= 20}
                  >
                    + Add
                  </button>
                  <input
                    ref={addDocumentsInputRef}
                    type="file"
                    accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    multiple
                    onChange={(event) => void handleAddDocuments(event)}
                    className="sr-only"
                  />
                </div>
              </div>
              <nav aria-labelledby="files-title">
                <h2 id="files-title" className="sr-only">Documents in this set</h2>
                {documentSet.documents.map((document) => (
                  <div className="file-tab-row" key={document.id}>
                    <button
                      type="button"
                      className={`file-tab ${document.id === activeDocumentId ? "active" : ""}`}
                      onClick={() => void openDocument(document)}
                      aria-current={document.id === activeDocumentId ? "page" : undefined}
                    >
                      <span className="word-icon" aria-hidden="true">W</span>
                      <span>
                        <strong>{document.name}</strong>
                        <small>{document.element_count} elements</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="file-remove-button"
                      onClick={() => void handleRemoveDocument(document)}
                      disabled={Boolean(busyAction) || documentSet.documents.length <= 2}
                      aria-label={`Remove ${document.name} from this set`}
                      title={
                        documentSet.documents.length <= 2
                          ? "A set must retain at least two documents"
                          : `Remove ${document.name}`
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </nav>
            </aside>

            <DocumentExperience
              documentSet={documentSet}
              document={activeDocument}
              searchTarget={documentSearchTarget}
              onGenerated={handleEditorGenerated}
              generationJobs={generationJobs}
              onGenerationQueued={handleGenerationQueued}
              onDirtyChange={setEditorDirty}
            />

          </div>

        </main>
      )}

    </div>
  );
}

function ErrorAlert({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="alert error-alert" role="alert">
      <strong>Something went wrong.</strong>
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error message"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`loading-state ${compact ? "compact" : ""}`} role="status"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

function CreationProgress({ stage }: { stage: Exclude<CreationStage, null> }) {
  const stages: Array<{
    id: Exclude<CreationStage, null>;
    label: string;
  }> = [
    { id: "upload", label: "Uploading local files" },
    { id: "validation", label: "Validating safe DOCX packages" },
    { id: "editor-preparation", label: "Preparing structured editor data" },
    { id: "workspace", label: "Opening the workspace" },
  ];
  const activeIndex = stages.findIndex((item) => item.id === stage);

  return (
    <div className="creation-progress" role="status" aria-live="polite">
      <strong>Creating your workspace</strong>
      <ol>
        {stages.map((item, index) => (
          <li
            className={
              index < activeIndex
                ? "complete"
                : index === activeIndex
                  ? "active"
                  : "pending"
            }
            key={item.id}
          >
            <span aria-hidden="true">{index < activeIndex ? "✓" : index + 1}</span>
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default App;
