import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  absoluteApiUrl,
  absoluteDownloadUrl,
  addDocumentsToSet,
  deleteDocumentSet,
  fetchDocumentSet,
  fetchDocumentSets,
  fetchDocumentView,
  fetchElementMatches,
  generateEdit,
  previewEdit,
  removeDocumentFromSet,
  searchDocumentSet,
  uploadDocumentSet,
} from "./api";
import type {
  DocumentSetLibraryItem,
  DocumentSetResponse,
  DocumentSummary,
  DocumentView,
  EditorGenerationResponse,
  GenerationResponse,
  GlobalSearchResult,
  MatchDiscovery,
  PreviewResponse,
  ViewerElement,
} from "./types";

import docSyncLogo from "./assets/Docsync LOGO.png";
import DocumentExperience from "./DocumentExperience";

type BusyAction =
  | "upload"
  | "open-set"
  | "view"
  | "matches"
  | "preview"
  | "generate"
  | "add-documents"
  | "remove-document"
  | "delete-set"
  | null;

const INITIAL_VISIBLE_PAGES = 8;
const VISIBLE_PAGE_BATCH = 8;

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elementLabel(elementType: string): string {
  if (elementType === "list_item") return "List item";
  if (elementType === "table_cell") return "Table cell";
  return elementType.charAt(0).toUpperCase() + elementType.slice(1);
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
    element.element_type === "table_cell" &&
    element.table_index !== undefined &&
    element.row_index !== undefined &&
    element.column_index !== undefined
  ) {
    return `Table ${element.table_index + 1} · Row ${element.row_index + 1} · Column ${
      element.column_index + 1
    }`;
  }

  return `${elementLabel(element.element_type)} · Paragraph ${
    element.paragraph_index + 1
  }`;
}

type PositionedViewerElement = ViewerElement & {
  preview_row_index?: number;
  preview_column_index?: number;
};

type ViewerBlock =
  | { kind: "element"; element: ViewerElement }
  | { kind: "table"; tableIndex: number; cells: PositionedViewerElement[] };

function groupViewerElements(elements: ViewerElement[]): ViewerBlock[] {
  const blocks: ViewerBlock[] = [];

  for (const element of elements) {
    if (
      element.element_type === "table_cell" &&
      element.table_index !== undefined
    ) {
      const previous = blocks.at(-1);
      if (
        previous?.kind === "table" &&
        previous.tableIndex === element.table_index
      ) {
        previous.cells.push(element);
      } else {
        blocks.push({
          kind: "table",
          tableIndex: element.table_index,
          cells: [element],
        });
      }
      continue;
    }

    blocks.push({ kind: "element", element });
  }

  for (const block of blocks) {
    if (block.kind !== "table") continue;

    const usedRows = Array.from(
      new Set(block.cells.map((cell) => cell.row_index ?? 0)),
    ).sort((left, right) => left - right);
    const usedColumns = Array.from(
      new Set(block.cells.map((cell) => cell.column_index ?? 0)),
    ).sort((left, right) => left - right);

    block.cells = block.cells.map((cell) => ({
      ...cell,
      preview_row_index: usedRows.indexOf(cell.row_index ?? 0),
      preview_column_index: usedColumns.indexOf(cell.column_index ?? 0),
    }));
  }

  return blocks;
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
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [activeDocumentId, setActiveDocumentId] = useState("");
  const [viewer, setViewer] = useState<DocumentView | null>(null);
  const [selectedElementId, setSelectedElementId] = useState("");
  const [discovery, setDiscovery] = useState<MatchDiscovery | null>(null);
  const [includedElementIds, setIncludedElementIds] = useState<string[]>([]);
  const [replacement, setReplacement] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [generation, setGeneration] = useState<GenerationResponse | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState(-1);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [visiblePageCount, setVisiblePageCount] = useState(INITIAL_VISIBLE_PAGES);
  const [viewMode, setViewMode] = useState<"visual" | "select">("visual");
  const [editorDirty, setEditorDirty] = useState(false);
  const viewerScrollRef = useRef<HTMLDivElement>(null);
  const addDocumentsInputRef = useRef<HTMLInputElement>(null);

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

  const setNameError =
  setNameTouched && setName.trim() === ""
    ? "Enter a document-set name."
    : "";

  const selectedElement = useMemo(() => {
    return (
      viewer?.pages
        .flatMap((page) => page.elements)
        .find((element) => element.id === selectedElementId) ?? null
    );
  }, [selectedElementId, viewer]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query || !viewer) return [];
    return viewer.pages
      .flatMap((page) => page.elements)
      .filter((element) => element.text.toLocaleLowerCase().includes(query));
  }, [searchQuery, viewer]);

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
    const query = globalSearchQuery.trim();
    if (!documentSet || query.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setGlobalSearchLoading(true);
      try {
        const response = await searchDocumentSet(documentSet.id, query);
        if (!cancelled) {
          setGlobalSearchResults(response.results);
          setGlobalSearchOpen(true);
        }
      } catch (caught) {
        if (!cancelled) {
          setGlobalSearchResults([]);
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
      window.clearTimeout(timeout);
    };
  }, [documentSet?.id, globalSearchQuery]);

  useEffect(() => {
    setSearchCursor(-1);
  }, [searchQuery, activeDocumentId]);

  useEffect(() => {
    if (!viewer) return;

    setVisiblePageCount(INITIAL_VISIBLE_PAGES);
    window.requestAnimationFrame(() => {
      viewerScrollRef.current?.scrollTo({
        top: 0,
        left: 0,
        behavior: "auto",
      });
      setCurrentPage(1);
    });
  }, [activeDocumentId, viewer?.version_id]);

  useEffect(() => {
    const container = viewerScrollRef.current;
    if (!container || !viewer) return;

    function updateCurrentPage() {
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const pages = Array.from(
        container.querySelectorAll<HTMLElement>("[data-page-number]"),
      );
      let closestPage = 1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const page of pages) {
        const distance = Math.abs(page.getBoundingClientRect().top - containerTop - 24);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = Number(page.dataset.pageNumber ?? 1);
        }
      }
      setCurrentPage(closestPage);

      const remainingScroll =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (remainingScroll < 1400) {
        setVisiblePageCount((current) =>
          Math.min(viewer?.pages.length ?? current + VISIBLE_PAGE_BATCH),
        );
      }
    }

    container.addEventListener("scroll", updateCurrentPage, { passive: true });
    updateCurrentPage();
    return () => container.removeEventListener("scroll", updateCurrentPage);
  }, [viewer, zoom]);

  useEffect(() => {
    if (!preview) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && busyAction !== "generate") setPreview(null);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busyAction, preview]);

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

  function clearSelection() {
    setSelectedElementId("");
    setDiscovery(null);
    setIncludedElementIds([]);
    setReplacement("");
    setPreview(null);
  }

  function resetWorkspace(updateHistory = true) {
    if (
      updateHistory &&
      editorDirty &&
      !window.confirm("Leave this workspace and discard the current editor draft?")
    ) {
      return;
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
    setViewer(null);
    setFiles([]);
    setGeneration(null);
    setEditorDirty(false);
    setError("");
    clearSelection();
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
    setError("");
  }

  async function openWorkspace(workspace: DocumentSetResponse) {
    if (workspace.documents.some((document) => !document.version_id)) {
      throw new Error(
        "The local document service is an older DocumentSync version. Close and reopen the application, then try again.",
      );
    }

    const firstDocument = workspace.documents[0] ?? null;
    const rendered = firstDocument
      ? await fetchDocumentView(firstDocument.version_id)
      : null;

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
    setViewer(rendered);
    setViewMode(rendered?.pdf_url ? "visual" : "select");
    setCurrentPage(1);
    setSearchQuery("");
    setGlobalSearchQuery("");
    setGlobalSearchResults([]);
    setGlobalSearchOpen(false);
    setGeneration(null);
    setEditorDirty(false);
    clearSelection();
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

  try {
    const uploaded = await uploadDocumentSet(trimmedSetName, files);
      await openWorkspace(uploaded);
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
      setBusyAction(null);
    }
  }

  async function openSavedWorkspace(item: DocumentSetLibraryItem) {
    setError("");
    setBusyAction("open-set");
    setOpeningSetId(item.id);
    try {
      await openWorkspace(await fetchDocumentSet(item.id));
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
      setGeneration(null);
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
      setSavedSets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? { ...item, document_count: updated.documents.length }
            : item,
        ),
      );
      setGeneration(null);
      clearSelection();

      if (activeDocumentId === document.id) {
        const nextDocument = updated.documents[0] ?? null;
        setActiveDocumentId(nextDocument?.id ?? "");
        setViewer(
          nextDocument ? await fetchDocumentView(nextDocument.version_id) : null,
        );
        setViewMode("select");
        setCurrentPage(1);
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
    await openDocument(targetDocument, result.element_id);
  }

  async function openDocument(document: DocumentSummary, targetElementId = "") {
    const hasDraft = Boolean(
      editorDirty ||
        (selectedElement &&
          replacement.trim() !== selectedElement.text.trim() &&
          !preview),
    );
    if (
      hasDraft &&
      !window.confirm("Switch documents and discard the unpreviewed replacement text?")
    ) {
      return;
    }

    setEditorDirty(false);
    setError("");
    setBusyAction("view");
    setActiveDocumentId(document.id);
    setViewer(null);
    setCurrentPage(1);
    setSearchQuery("");
    clearSelection();
    try {
      const rendered = await fetchDocumentView(document.version_id);
      setViewer(rendered);
      setViewMode(targetElementId ? "select" : rendered.pdf_url ? "visual" : "select");

      if (targetElementId) {
        const targetElement =
          rendered.pages
            .flatMap((page) => page.elements)
            .find((element) => element.id === targetElementId) ?? null;
        if (targetElement) {
          setVisiblePageCount((current) =>
            Math.max(current, targetElement.page_number),
          );
          await selectElement(targetElement);
          window.setTimeout(() => {
            window.document
              .getElementById(`element-${targetElementId}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 50);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document preview failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function selectElement(element: ViewerElement) {
    setSelectedElementId(element.id);
    setReplacement(element.text);
    setPreview(null);
    setError("");
    setBusyAction("matches");
    try {
      const matches = await fetchElementMatches(element.id);
      setDiscovery(matches);
      setIncludedElementIds(
        matches.link_group
          ? matches.link_group.members.map((member) => member.element_id)
          : [element.id],
      );
    } catch (caught) {
      setDiscovery(null);
      setIncludedElementIds([element.id]);
      setError(caught instanceof Error ? caught.message : "Match discovery failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function toggleTarget(elementId: string) {
    if (elementId === selectedElementId) return;
    setIncludedElementIds((current) =>
      current.includes(elementId)
        ? current.filter((item) => item !== elementId)
        : [...current, elementId],
    );
    setPreview(null);
  }

  function moveSearch(direction: 1 | -1) {
    if (searchMatches.length === 0) return;
    const next =
      (searchCursor + direction + searchMatches.length) % searchMatches.length;
    const target = searchMatches[next];

    setSearchCursor(next);
    setVisiblePageCount((current) => Math.max(current, target.page_number));
    window.setTimeout(() => {
      document
        .getElementById(`element-${target.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }

  async function handlePreview() {
    if (!documentSet || !discovery?.link_group || !selectedElement) return;
    setError("");
    setBusyAction("preview");
    try {
      setPreview(
        await previewEdit(
          documentSet.id,
          discovery.link_group.id,
          replacement,
          selectedElement.id,
          includedElementIds,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGenerate() {
    if (!documentSet || !discovery?.link_group || !selectedElement) return;
    setError("");
    setBusyAction("generate");
    try {
      const result = await generateEdit(
        documentSet.id,
        discovery.link_group.id,
        replacement,
        selectedElement.id,
        includedElementIds,
      );
      setDocumentSet(result.document_set);
      setGeneration(result);
      setSavedSets((current) =>
        current.map((item) =>
          item.id === result.document_set.id
            ? {
                ...item,
                name: result.document_set.name,
                document_count: result.document_set.documents.length,
                edit_count: item.edit_count + 1,
              }
            : item,
        ),
      );
      setPreview(null);
      clearSelection();
      setViewer(null);
      setViewMode("visual");
      setBusyAction("view");

      const refreshedDocument = result.document_set.documents.find(
        (document) => document.id === activeDocumentId,
      );
      if (refreshedDocument) {
        try {
          const rendered = await fetchDocumentView(refreshedDocument.version_id);
          setViewer(rendered);
          setViewMode(rendered.pdf_url ? "visual" : "select");
          setCurrentPage(1);
        } catch (caught) {
          setViewer(null);
          setError(
            `The changes were applied, but the refreshed preview could not open: ${
              caught instanceof Error ? caught.message : "Unknown preview error."
            }`,
          );
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Generation failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function handleEditorGenerated(result: EditorGenerationResponse) {
    const updated = result.document_set;
    if (updated) {
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
    setGeneration(null);
    setEditorDirty(false);
  }

  function renderViewerElement(
    element: PositionedViewerElement,
    insideTable = false,
  ) {
    const isSearchMatch =
      Boolean(searchQuery.trim()) &&
      searchMatches.some((match) => match.id === element.id);

    const tableStyle =
      insideTable &&
      element.row_index !== undefined &&
      element.column_index !== undefined
        ? {
            gridRow:
              (element.preview_row_index ?? element.row_index) + 1,
            gridColumn:
              (element.preview_column_index ?? element.column_index) + 1,
            minWidth: 0,
          }
        : undefined;

    return (
      <button
        type="button"
        id={`element-${element.id}`}
        key={element.id}
        className={`document-element ${element.element_type} ${
          insideTable ? "inside-table" : ""
        } ${selectedElementId === element.id ? "selected" : ""} ${
          isSearchMatch ? "search-match" : ""
        }`}
        style={tableStyle}
        onClick={() => void selectElement(element)}
        aria-pressed={selectedElementId === element.id}
        aria-label={`Select ${elementLabel(element.element_type)}: ${element.text}`}
      >
        <span className="selection-marker" aria-hidden="true">Edit</span>
        {element.element_type === "table_cell" && (
          <small className="table-cell-location">
            {elementLocation(element)}
          </small>
        )}
        <span>{element.text}</span>
      </button>
    );
  }


const canUpload = files.length >= 2 && !busyAction;
  const canPreview = Boolean(
    documentSet &&
      discovery?.link_group &&
      selectedElement &&
      replacement.trim().length > 0 &&
      includedElementIds.includes(selectedElement.id) &&
      !busyAction,
  );

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

        <div className="topbar-actions">
          {/* <span className="release-pill">Desktop v1</span> */}
          {documentSet && (
            <button type="button" className="quiet-button" onClick={() => resetWorkspace()}>
              Home
            </button>
          )}
        </div>
      </header>

      {!documentSet ? (
        <main id="top">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">Open. Select. Synchronise safely.</p>
              <h1>Edit shared content in the documents you already use.</h1>
              <p className="hero-text">
                View uploaded Word documents in the browser, choose an exact shared element,
                review every target, and create new versions without touching the originals.
              </p>
            </div>
            <div className="workflow-card" aria-label="Document editing workflow">
              <div><span>1</span><p><strong>Open</strong><small>Scroll through each document</small></p></div>
              <div><span>2</span><p><strong>Select</strong><small>Choose recognised content</small></p></div>
              <div><span>3</span><p><strong>Review</strong><small>Confirm every exact match</small></p></div>
            </div>
          </section>

          <section className="upload-workspace" aria-labelledby="upload-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Start a workspace</p>
                <h2 id="upload-title">Upload a related document set</h2>
              </div>
              <p>Choose 2–20 DOCX files. Exact repeated paragraphs are linked automatically.</p>
            </div>

            {error && <ErrorAlert message={error} />}

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
        <main id="top" className={`phase-two-main ${generation ? "has-download-dock" : ""}`}>
          <section className="workspace-heading" aria-labelledby="workspace-title">
            <div>
              <p className="eyebrow">Document set</p>
              <h1 id="workspace-title">{documentSet.name}</h1>
            </div>

            <div className="workspace-heading-actions">
              <div className="global-set-search" role="search">
                <label htmlFor="global-document-search" className="sr-only">
                  Search all documents in this set
                </label>
                <input
                  id="global-document-search"
                  type="search"
                  value={globalSearchQuery}
                  onChange={(event) => setGlobalSearchQuery(event.target.value)}
                  onFocus={() => setGlobalSearchOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setGlobalSearchOpen(false);
                  }}
                  placeholder="Search all documents"
                />
                {globalSearchLoading && <span className="global-search-status">Searching…</span>}
                {globalSearchOpen && globalSearchQuery.trim().length >= 2 && (
                  <div className="global-search-results">
                    {!globalSearchLoading && globalSearchResults.length === 0 ? (
                      <div className="global-search-empty">No matches in this document set.</div>
                    ) : (
                      globalSearchResults.map((result) => (
                        <button
                          type="button"
                          key={result.element_id}
                          onClick={() => void openGlobalSearchResult(result)}
                        >
                          <strong>{result.document_name}</strong>
                          <span>{result.text}</span>
                          <small>{elementLocation(result)}</small>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="set-summary">
                <strong>{documentSet.documents.length}</strong><span>documents</span>
                <strong>{documentSet.link_group_count ?? documentSet.link_groups.length}</strong><span>exact groups</span>
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

          {error && <ErrorAlert message={error} />}

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
              <div className="rail-guide">
                <strong>Safe edit path</strong>
                <ol>
                  <li className={selectedElement ? "done" : "current"}>Select an element</li>
                  <li className={preview ? "done" : selectedElement ? "current" : ""}>Confirm exact matches</li>
                  <li className={preview ? "current" : ""}>Review and apply</li>
                </ol>
              </div>
            </aside>

            <DocumentExperience
              documentSet={documentSet}
              document={activeDocument}
              fallbackView={viewer}
              onGenerated={handleEditorGenerated}
              onDirtyChange={setEditorDirty}
            />

            {Boolean(0) && (
              <>
            <section className="viewer-panel" aria-labelledby="viewer-title">
              <div className="viewer-toolbar">
                <div className="viewer-title">
                  <strong id="viewer-title">{activeDocument?.name ?? "Document preview"}</strong>
                  <span>{viewer?.render_mode === "word_pdf" ? "Microsoft Word layout" : "Structured preview"}</span>
                </div>
                {viewer?.pdf_url && (
                  <div className="view-mode-toggle" role="group" aria-label="Preview mode">
                    <button type="button" className={viewMode === "visual" ? "active" : ""} onClick={() => setViewMode("visual")} aria-pressed={viewMode === "visual"}>Word layout</button>
                    <button type="button" className={viewMode === "select" ? "active" : ""} onClick={() => setViewMode("select")} aria-pressed={viewMode === "select"}>Select text</button>
                  </div>
                )}
                {viewMode === "select" && (
                  <>
                    <div className="search-control" role="search">
                      <label htmlFor="document-search" className="sr-only">Search document text</label>
                      <input
                        id="document-search"
                        type="search"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Search text"
                        disabled={!viewer}
                      />
                      {searchQuery && <small>{searchMatches.length} found</small>}
                      <button type="button" onClick={() => moveSearch(-1)} disabled={!searchMatches.length} aria-label="Previous search result">↑</button>
                      <button type="button" onClick={() => moveSearch(1)} disabled={!searchMatches.length} aria-label="Next search result">↓</button>
                    </div>
                    <div className="viewer-controls" aria-label="Document view controls">
                      <span className="page-indicator">Page {currentPage} / {viewer?.page_count ?? 0}</span>
                      <button type="button" onClick={() => setZoom((value) => Math.max(0.75, value - 0.1))} disabled={!viewer || zoom <= 0.75} aria-label="Zoom out">−</button>
                      <span>{Math.round(zoom * 100)}%</span>
                      <button type="button" onClick={() => setZoom((value) => Math.min(1.35, value + 0.1))} disabled={!viewer || zoom >= 1.35} aria-label="Zoom in">+</button>
                      <button type="button" className="fit-button" onClick={() => setZoom(1)} disabled={!viewer}>Fit width</button>
                    </div>
                  </>
                )}
              </div>

              <div className="viewer-scroll" ref={viewerScrollRef} aria-busy={busyAction === "view"}>
                {busyAction === "view" && <LoadingState label="Opening document preview…" />}
                {!viewer && busyAction !== "view" && <LoadingState label="Preview unavailable" />}
                {viewer && viewMode === "visual" && viewer.pdf_url && (
                  <div className="word-preview">
                    <div className="render-notice"><strong>Word layout</strong><span>{viewer.notice}</span></div>
                    <iframe
                      src={absoluteApiUrl(viewer.pdf_url)}
                      title={`${viewer.document_name} Word layout preview`}
                    />
                  </div>
                )}
                {viewer && viewMode === "select" && (
                  <>
                    <div className="render-notice"><strong>Preview note</strong><span>{viewer.notice}</span></div>
                    <div className="page-stack" style={{ "--page-zoom": zoom } as CSSProperties}>
                      {viewer.pages.slice(0, visiblePageCount).map((page) => (
                        <section className="document-page" key={page.page_number} data-page-number={page.page_number} aria-label={`Page ${page.page_number}`}>
                          <span className="page-label">Page {page.page_number}</span>
                          <div className="page-content">
                            {page.elements.length === 0 ? (
                              <p className="empty-page">No supported text elements on this page.</p>
                            ) : (
                              groupViewerElements(page.elements).map((block, blockIndex) =>
                                block.kind === "table" ? (
                                  <section
                                    className="structured-table"
                                    key={`table-${block.tableIndex}-${blockIndex}`}
                                    aria-label={`Table ${block.tableIndex + 1}`}
                                  >
                                    <div className="structured-table-heading">
                                      Table {block.tableIndex + 1}
                                    </div>
                                    <div
                                      className="structured-table-grid"
                                      style={{
                                        gridTemplateColumns: `repeat(${
                                          Math.max(
                                            ...block.cells.map(
                                              (cell) =>
                                                (cell.preview_column_index ??
                                                  cell.column_index ??
                                                  0) + 1,
                                            ),
                                          )
                                        }, minmax(120px, 1fr))`,
                                      }}
                                    >
                                      {block.cells.map((cell) =>
                                        renderViewerElement(cell, true),
                                      )}
                                    </div>
                                  </section>
                                ) : (
                                  renderViewerElement(block.element)
                                ),
                              )
                            )}
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>

            <aside className="edit-sidebar" aria-labelledby="edit-sidebar-title">
              <div className="sidebar-heading">
                <div><span className="eyebrow">Controlled edit</span><h2 id="edit-sidebar-title">Selected content</h2></div>
                {selectedElement && <span className="element-chip">{elementLabel(selectedElement.element_type)}</span>}
              </div>

              {!selectedElement ? (
                <div className="sidebar-empty">
                  <span aria-hidden="true">T</span>
                  <h3>{viewMode === "visual" ? "Viewing the Word layout" : "Select text in the document"}</h3>
                  <p>{viewMode === "visual" ? "This view uses Microsoft Word’s own layout. Switch to Select text when you are ready to choose content to edit." : "Supported paragraphs, headings, list items, and table cells highlight as you hover or focus them."}</p>
                  {viewMode === "visual" && viewer?.pdf_url && <button type="button" className="quiet-button" onClick={() => setViewMode("select")}>Switch to Select text</button>}
                </div>
              ) : (
                <div className="edit-flow">
                  <div className="source-card">
                    <small>Source · {elementLocation(selectedElement)}</small>
                    <p>{selectedElement.text}</p>
                  </div>

                  {busyAction === "matches" ? (
                    <LoadingState label="Finding exact matches…" compact />
                  ) : discovery?.link_group ? (
                    <section className="targets-section" aria-labelledby="targets-title">
                      <div className="targets-heading">
                        <div><h3 id="targets-title">Confirmed locations</h3><p>Exact matches start included. Review each one.</p></div>
                        <span>{includedElementIds.length}/{discovery.link_group.member_count}</span>
                      </div>
                      <div className="target-list">
                        {discovery.link_group.members.map((member) => {
                          const isSource = member.element_id === selectedElement.id;
                          return (
                            <label className={`target-row ${includedElementIds.includes(member.element_id) ? "included" : "excluded"}`} key={member.element_id}>
                              <input
                                type="checkbox"
                                checked={includedElementIds.includes(member.element_id)}
                                onChange={() => toggleTarget(member.element_id)}
                                disabled={isSource}
                              />
                              <span>
                                <strong>{member.document_name}</strong>
                                <small>
                                  {isSource
                                    ? `Source · ${elementLocation(member)} · always included`
                                    : `${elementLocation(member)} · Exact match`}
                                </small>
                              </span>
                              <em>{includedElementIds.includes(member.element_id) ? "Included" : "Excluded"}</em>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  ) : (
                    <div className="no-match-state" role="status">
                      <strong>No exact matches</strong>
                      <p>This element is selectable, but synchronised editing currently requires an exact match in another document.</p>
                    </div>
                  )}

                  <label className="field replacement-field">
                    <span>Replacement text</span>
                    <textarea
                      value={replacement}
                      onChange={(event) => {
                        setReplacement(event.target.value);
                        setPreview(null);
                      }}
                      rows={7}
                      maxLength={20000}
                      disabled={!discovery?.link_group}
                    />
                    <small>{replacement.length.toLocaleString()} / 20,000 characters</small>
                  </label>

                  <div className="edit-actions">
                    <button type="button" className="quiet-button" onClick={clearSelection}>Cancel</button>
                    <button type="button" className="primary-button" disabled={!canPreview} onClick={() => void handlePreview()}>
                      {busyAction === "preview" ? "Validating…" : `Preview ${includedElementIds.length} change${includedElementIds.length === 1 ? "" : "s"}`}
                    </button>
                  </div>
                  <p className="immutability-note"><span aria-hidden="true">◇</span> Previewing and generating never overwrite an original upload.</p>
                </div>
              )}
            </aside>
              </>
            )}
          </div>

          {generation && (
            <section className="generation-banner download-dock" aria-live="polite">
              <span className="success-icon" aria-hidden="true">✓</span>
              <div>
                <strong>Changes applied — continue editing above</strong>
                <p>The Word preview is showing the current documents. When you’re finished with every edit, download the complete set.</p>
              </div>
              <a className="download-button" href={absoluteDownloadUrl(generation.download_url)}>
                Done editing — download all
              </a>
            </section>
          )}
        </main>
      )}

      {preview && (
        <div className="modal-backdrop" role="presentation">
          <section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <header className="preview-dialog-header">
              <div><p className="eyebrow">Review required</p><h2 id="preview-title">Confirm the full impact</h2><p>{preview.affected_location_count} locations across {preview.affected_document_count} documents</p></div>
              <button type="button" className="dialog-close" onClick={() => setPreview(null)} disabled={busyAction === "generate"} aria-label="Close preview">×</button>
            </header>
            <div className="preview-dialog-body">
              {preview.documents.map((document) => (
                <article className="preview-document" key={document.document_id}>
                  <header><span className="word-icon" aria-hidden="true">W</span><div><h3>{document.document_name}</h3><p>{document.changes.length} confirmed location{document.changes.length === 1 ? "" : "s"}</p></div></header>
                  {document.changes.map((change) => (
                    <div className="diff" key={change.element_id}>
                      <p className="location-label">{elementLocation(change)}</p>
                      <div className="diff-grid">
                        <div className="diff-side before"><span>Before</span><p>{change.before}</p></div>
                        <div className="diff-arrow" aria-hidden="true">→</div>
                        <div className="diff-side after"><span>After</span><p>{change.after}</p></div>
                      </div>
                    </div>
                  ))}
                </article>
              ))}
            </div>
            <footer className="preview-dialog-footer">
              <div><strong>Safe to apply</strong><span>Only the locations shown above will change. You can continue editing the updated versions, and the original uploads remain unchanged.</span></div>
              <div><button type="button" className="quiet-button" onClick={() => setPreview(null)} disabled={busyAction === "generate"}>Back to edit</button><button type="button" className="primary-button" onClick={() => void handleGenerate()} disabled={busyAction === "generate"}>{busyAction === "generate" ? "Applying changes…" : "Apply changes and continue"}</button></div>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return <div className="alert error-alert" role="alert"><strong>Something went wrong.</strong><span>{message}</span></div>;
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`loading-state ${compact ? "compact" : ""}`} role="status"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

export default App;
