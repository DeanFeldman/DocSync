import {
  ChangeEvent,
  FormEvent,
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
  renameDocumentInSet,
  renameDocumentSet,
  uploadDocumentSet,
  versionDownloadUrl,
} from "./api";
import type {
  DocumentSetLibraryItem,
  DocumentSetResponse,
  DocumentSummary,
  DocumentVersionRestoreResponse,
  EditorGenerationResponse,
} from "./types";

import DocumentVersionHistory from "./DocumentVersionHistory";
import LocalOfficeEditor from "./LocalOfficeEditor";
import DocSyncData from "./DocSyncData";
import { useConfirmation } from "./ConfirmationDialog";
import { useDismissibleMenu } from "./useDismissibleMenu";
import {
  clearWorkspaceResourcesForDocument,
  clearWorkspaceResourcesForSet,
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
  | "rename"
  | "delete-set"
  | null;

type CreationStage =
  | "upload"
  | "validation"
  | "editor-preparation"
  | "workspace"
  | null;

function AppearanceIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "system") {
    return <span className="theme-toggle-icon theme-system-icon" aria-hidden="true" />;
  }
  return <span className="theme-toggle-icon" aria-hidden="true">{preference === "dark" ? "☾" : "☀"}</span>;
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const confirm = useConfirmation();
  const appearanceMenuRef = useDismissibleMenu();
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
  const [activeDocumentId, setActiveDocumentId] = useState("");
  const [historyDocumentId, setHistoryDocumentId] = useState("");
  const [editorReset, setEditorReset] = useState(0);
  const [restoreNotice, setRestoreNotice] = useState("");
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [officeToolbar, setOfficeToolbar] = useState<HTMLDivElement | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: "file" | "set"; id: string } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [inlineSetName, setInlineSetName] = useState<string | null>(null);
  const [renameError, setRenameError] = useState("");
  const renameDialog = useRef<HTMLDialogElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [creationStage, setCreationStage] = useState<CreationStage>(null);
  const [error, setError] = useState("");
  const [generationJobs, setGenerationJobs] = useState<EditorGenerationResponse[]>([]);
  const addDocumentsInputRef = useRef<HTMLInputElement>(null);
  const handledGenerationJobsRef = useRef(new Set<string>());

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

  useEffect(() => {
    if (!documentSet?.id) return;
    function dismissFileActions() {
      document.querySelector<HTMLElement>(".file-actions-popover:popover-open")?.hidePopover();
    }
    window.addEventListener("blur", dismissFileActions);
    return () => window.removeEventListener("blur", dismissFileActions);
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
  const historyDocument = documentSet?.documents.find((file) => file.id === historyDocumentId);

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
          name: current.name,
          documents: current.documents.map((item) => updatedById.get(item.id) ?? item),
        };
      });
      setSavedSets((current) =>
        current.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                document_count:
                  updated?.documents.length ?? item.document_count,
                edit_count: item.edit_count + 1,
              }
            : item,
        ),
      );
    }

  }

  function resetWorkspace(updateHistory = true) {
    if (
      updateHistory &&
      documentSet &&
      window.history.state?.view === "workspace"
    ) {
      window.history.back();
      return;
    }

    setDocumentSet(null);
    setInlineSetName(null);
    setActiveDocumentId("");
    setHistoryDocumentId("");
    setRestoreNotice("");
    setFiles([]);
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
    const confirmed = await confirm({
      title: `Delete "${item.name}" permanently?`,
      message: "This removes the saved set and its local files. This cannot be undone.",
      action: "Delete set",
      destructive: true,
    });
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

  useEffect(() => {
    if (!renameTarget || !renameDialog.current || renameDialog.current.open) return;
    renameDialog.current.showModal();
    renameInput.current?.select();
  }, [renameTarget]);

  function closeRename() {
    renameDialog.current?.close();
    setRenameTarget(null);
  }

  function beginRename(kind: "file" | "set", id: string, name: string) {
    setRenameName(kind === "file" ? name.replace(/\.docx$/i, "") : name);
    setRenameError("");
    setRenameTarget({ kind, id });
  }

  async function saveSetName(id: string, name: string) {
    const renamed = await renameDocumentSet(id, name);
    setDocumentSet((current) => current?.id === renamed.id ? { ...current, name: renamed.name } : current);
    setSavedSets((current) => current.map((item) => item.id === renamed.id ? { ...item, name: renamed.name } : item));
  }

  async function finishInlineSetRename(value: string) {
    setInlineSetName(null);
    const name = value.trim();
    if (!documentSet || !name || name === documentSet.name || busyAction) return;
    const id = documentSet.id;
    setBusyAction("rename");
    setError("");
    try {
      if (await confirm({
        title: "Rename document set?",
        message: `Rename “${documentSet.name}” to “${name}”?`,
        action: "Rename",
      })) await saveSetName(id, name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The name could not be saved.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget || !renameName.trim() || busyAction) return;
    setBusyAction("rename");
    setRenameError("");
    try {
      if (renameTarget.kind === "set") {
        await saveSetName(renameTarget.id, renameName);
      } else if (documentSet) {
        const setId = documentSet.id;
        const renamed = await renameDocumentInSet(setId, renameTarget.id, renameName);
        setDocumentSet((current) => current?.id === setId ? {
          ...current,
          documents: current.documents.map((file) => file.id === renamed.id ? { ...file, name: renamed.name } : file),
        } : current);
      }
      closeRename();
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "The name could not be saved.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRemoveDocument(document: DocumentSummary) {
    if (!documentSet) return;
    const confirmed = await confirm({
      title: `Remove "${document.name}" from this set?`,
      message: "The set must retain at least two documents.",
      action: "Remove document",
      destructive: true,
    });
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

  function openDocument(document: DocumentSummary) {
    setError("");
    setRestoreNotice("");
    setActiveDocumentId(document.id);
  }

  function handleEditorGenerated(result: EditorGenerationResponse) {
    const updated = result.document_set;
    if (updated) {
      for (const changedVersion of result.versions ?? []) {
        invalidateDocumentHeadResources(updated.id, changedVersion.document_id);
      }
      setDocumentSet((current) => current?.id === updated.id ? { ...updated, name: current.name } : current);
      setSavedSets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                document_count: updated.documents.length,
                edit_count: item.edit_count + 1,
              }
            : item,
        ),
      );
    }
  }

  function handleVersionRestored(result: DocumentVersionRestoreResponse) {
    setHistoryDocumentId("");
    handleEditorGenerated({
      ...result,
      generation_id: result.generation_id ?? result.operation_id,
      versions: [result.version],
    });
    if (result.document_id === activeDocumentId) setEditorReset((value) => value + 1);
    setRestoreNotice(`Restored version ${result.restored_from_version_number} of ${result.document_name} as version ${result.version.version_number}.`);
  }

  const canUpload = files.length >= 2 && !busyAction;
  return (
    <div className={`app-shell ${documentSet ? "workspace-mode" : ""}`}>
      <header className="topbar">
        {documentSet ? (
          <button type="button" className="danger-button"
            disabled={Boolean(busyAction)}
            onClick={() => void handleDeleteDocumentSet({
              id: documentSet.id,
              name: documentSet.name,
              created_at: documentSet.created_at,
              document_count: documentSet.documents.length,
              edit_count: savedSets.find((item) => item.id === documentSet.id)?.edit_count ?? 0,
            })}>
            Delete set
          </button>
        ) : (
          <a className="brand" href="#top" aria-label="DocSync home">
            <strong>DocSync</strong>
          </a>
        )}

        <div className="topbar-actions">
          <span
            className="version-badge"
            aria-label={`DocSync version ${__DOCSYNC_VERSION__}`}
          >
            v{__DOCSYNC_VERSION__}
          </span>
          <details ref={appearanceMenuRef} className="theme-selector">
            <summary aria-label="Choose appearance">
              <AppearanceIcon preference={themePreference} />
              <span>Appearance</span>
            </summary>
            <div className="theme-selector-menu appearance-options" role="menu" aria-label="Appearance">
              <strong>Appearance</strong>
              {(["system", "light", "dark"] as ThemePreference[]).map((preference) => (
                <button key={preference} type="button" className={themePreference === preference ? "selected" : ""} onClick={() => selectThemePreference(preference)} role="menuitemradio" aria-checked={themePreference === preference}>
                  <AppearanceIcon preference={preference} />
                  <span>{preference[0].toUpperCase() + preference.slice(1)}</span>
                </button>
              ))}
            </div>
          </details>
          <DocSyncData appearance={themePreference} />
          {documentSet && (
            <button type="button" className="quiet-button" onClick={() => resetWorkspace()}>
              Home
            </button>
          )}
        </div>
      </header>

      {historyDocument && <DocumentVersionHistory
        key={historyDocument.id}
        document={historyDocument}
        onClose={() => setHistoryDocumentId("")}
        onRestored={handleVersionRestored}
      />}

      {renameTarget && <dialog
        ref={renameDialog}
        className="workspace-confirmation"
        aria-labelledby="rename-title"
        onCancel={(event) => {
          event.preventDefault();
          if (busyAction !== "rename") closeRename();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && busyAction !== "rename") closeRename();
        }}
      >
        <form className="workspace-confirmation-content rename-file-form" onSubmit={(event) => void handleRename(event)}>
          <h2 id="rename-title">{renameTarget.kind === "set" ? "Rename document set" : "Rename file"}</h2>
          <label>
            {renameTarget.kind === "set" ? "Document set name" : "File name"}
            <input ref={renameInput} autoFocus required value={renameName} maxLength={renameTarget.kind === "set" ? 200 : 250}
              onChange={(event) => setRenameName(event.target.value)} disabled={busyAction === "rename"} />
          </label>
          {renameError && <p role="alert">{renameError}</p>}
          <div className="workspace-confirmation-actions">
            <button type="button" className="quiet-button" onClick={closeRename} disabled={busyAction === "rename"}>Cancel</button>
            <button type="submit" className="primary-button" disabled={!renameName.trim() || busyAction === "rename"}>Rename</button>
          </div>
        </form>
      </dialog>}

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
            {error && (
              <ErrorAlert message={error} onDismiss={() => setError("")} />
            )}

            <form className="upload-panel" onSubmit={handleUpload} noValidate>
              <h2 id="upload-title" className="upload-title">Start a workspace</h2>
              <label className="field">
                <span>Name</span>

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
                <span className="file-drop-label">
                  <strong>Select Word documents</strong>
                  <small>Choose 2–20 DOCX files</small>
                </span>
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
                      <div className="saved-workspace-actions">
                        <button
                          type="button"
                          className="quiet-button"
                          onClick={() => beginRename("set", item.id, item.name)}
                          disabled={Boolean(busyAction)}
                          aria-label={`Rename ${item.name}`}
                        >
                          Rename
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
                      </div>
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
            <h1 id="workspace-title">
              <span className="workspace-set-label">Document set:</span>
              {inlineSetName === null ? (
                <button type="button" className="workspace-set-name" disabled={Boolean(busyAction)}
                  aria-label={`Rename ${documentSet.name}`} title="Click to rename"
                  onClick={() => setInlineSetName(documentSet.name)}>{documentSet.name}</button>
              ) : (
                <input className="workspace-set-name-input" aria-label="Document set name" maxLength={200}
                  autoFocus value={inlineSetName} onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setInlineSetName(event.currentTarget.value)}
                  onBlur={(event) => void finishInlineSetRename(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setInlineSetName(null);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }} />
              )}
            </h1>
            <div className="workspace-heading-controls">
              <div className="office-toolbar-slot" ref={setOfficeToolbar} />
              <button
                type="button"
                className="file-rail-toggle"
                aria-expanded={!filesCollapsed}
                aria-controls="document-file-list"
                aria-label={filesCollapsed ? "Expand files" : "Collapse files"}
                title={filesCollapsed ? "Expand files" : "Collapse files"}
                onClick={() => {
                  window.document.querySelector<HTMLElement>(".file-actions-popover:popover-open")?.hidePopover();
                  setFilesCollapsed((collapsed) => !collapsed);
                }}
              >
                <span className="file-rail-icon" aria-hidden="true" />
                <span>Files</span>
              </button>
            </div>
          </section>

          {error && (
            <ErrorAlert message={error} onDismiss={() => setError("")} />
          )}

          <div className="document-workspace">
            <aside id="document-file-list" className="file-rail" aria-label="Files" hidden={filesCollapsed}>
              <nav aria-labelledby="files-title">
                <h2 id="files-title" className="sr-only">Documents in this set</h2>
                {documentSet.documents.map((document) => (
                  <div className="file-tab-row" key={document.id}>
                    <button
                      type="button"
                      className={`file-tab ${document.id === activeDocumentId ? "active" : ""}`}
                      title={document.name}
                      onClick={() => openDocument(document)}
                      aria-current={document.id === activeDocumentId ? "page" : undefined}
                    >
                      <span className="word-icon" aria-hidden="true">W</span>
                      <span>
                        <strong>{document.name}</strong>
                        <small>Version {document.version_number ?? 1}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="file-actions-trigger"
                      popoverTarget={`file-actions-${document.id}`}
                      aria-label={`Options for ${document.name}`}
                      title={`Options for ${document.name}`}
                    >
                      <span aria-hidden="true">⋯</span>
                    </button>
                    <div id={`file-actions-${document.id}`} popover="auto" className="file-actions-popover">
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={(event) => {
                          event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                          beginRename("file", document.id, document.name);
                        }}
                      >
                        Rename…
                      </button>
                      <a
                        href={document.download_url
                          ? absoluteApiUrl(document.download_url)
                          : versionDownloadUrl(document.current_version_id ?? document.version_id)}
                        download
                        onClick={(event) => event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover()}
                      >
                        Download current
                      </a>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                          setHistoryDocumentId(document.id);
                        }}
                      >
                        Version history
                      </button>
                      <button
                        type="button"
                        className="file-action-remove"
                        onClick={(event) => {
                          event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                          void handleRemoveDocument(document);
                        }}
                        disabled={Boolean(busyAction) || documentSet.documents.length <= 2}
                        title={documentSet.documents.length <= 2 ? "A set must retain at least two documents" : undefined}
                      >
                        Remove from set
                      </button>
                    </div>
                  </div>
                ))}
              </nav>
              <div className="rail-heading-actions">
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
            </aside>

            {activeDocument && <section className="office-workspace" aria-label={activeDocument.name}>
              {restoreNotice && <p className="local-office-notice" role="status">{restoreNotice}</p>}
              <LocalOfficeEditor
                key={`${activeDocument.id}:${editorReset}`}
                documentId={activeDocument.id}
                toolbarTarget={officeToolbar}
                onGenerated={handleEditorGenerated}
              />
            </section>}

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
