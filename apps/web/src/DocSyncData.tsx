import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useConfirmation } from "./ConfirmationDialog";
import { useDismissibleMenu } from "./useDismissibleMenu";

interface ImportPreview {
  import_id: string;
  sets: number;
  documents: number;
  versions: number;
}

export default function DocSyncData({ appearance }: { appearance: string }) {
  const [workspaces, setWorkspaces] = useState<DocSyncLocalWorkspace[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const local = window.docSync?.localData;
  const menuRef = useDismissibleMenu();
  const confirm = useConfirmation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void local?.listWorkspaces().then(setWorkspaces).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Could not list local workspaces.");
    });
  }, [local]);

  async function inspect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("archive", file);
      const response = await fetch("/api/local-workspace/imports", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "The backup could not be validated.");
      setPreview(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The backup could not be validated.");
    } finally {
      setBusy(false);
    }
  }

  async function finishImport() {
    if (!local || !preview) return;
    setBusy(true);
    setError("");
    try {
      await local.finishImport(preview.import_id);
      window.history.replaceState({ view: "home" }, "");
      window.location.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "DocSync could not open the imported workspace.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelImport() {
    if (!local || !preview) return;
    try {
      await local.discardImport(preview.import_id);
      setPreview(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "DocSync could not remove the staged import.");
    }
  }

  async function switchWorkspace(id: string) {
    if (!local || busy) return;
    if (!(await confirm({
      title: "Open the selected local workspace?",
      message: "Save any edits in progress before switching workspaces.",
      action: "Open workspace",
    }))) return;
    setError("");
    setBusy(true);
    try {
      await local.openWorkspace(id);
      window.history.replaceState({ view: "home" }, "");
      window.location.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "DocSync could not open that workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="theme-selector local-data" ref={menuRef}>
      <summary>Local data</summary>
      <div className="theme-selector-menu local-data-menu">
        <div className="local-data-heading">
          <strong>Workspace backup</strong>
          <p>Save a ZIP to move your documents and version history to another device.</p>
        </div>
        <div className="local-data-actions">
          <a
            className="local-data-action"
            href={"/api/local-workspace/export?appearance=" + encodeURIComponent(appearance)}
            download
          >
            <svg className="local-data-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 16v5h18v-5M12 17V3M7.5 7.5 12 3l4.5 4.5" />
            </svg>
            <span>Export all DocSync data</span>
          </a>
          {local && !preview && (
            <>
              <button
                className="local-data-action"
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <svg className="local-data-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 16v5h18v-5M12 3v14m-4.5-4.5L12 17l4.5-4.5" />
                </svg>
                <span>Import backup ZIP</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                disabled={busy}
                onChange={(event) => void inspect(event)}
              />
            </>
          )}
        </div>
        {preview && (
          <section className="local-data-confirmation" aria-label="Confirm workspace import">
            <strong>Import as a separate workspace?</strong>
            <p>{preview.sets} sets, {preview.documents} documents, {preview.versions} versions. Your current workspace will remain available.</p>
            <div>
              <button type="button" disabled={busy} onClick={() => void finishImport()}>Import workspace</button>
              <button type="button" disabled={busy} onClick={() => void cancelImport()}>Cancel</button>
            </div>
          </section>
        )}
        {workspaces.length > 1 && (
          <section className="local-data-workspaces" aria-label="Local workspaces">
            <strong>Open a workspace</strong>
            <ul>
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className="local-data-workspace"
                    aria-current={workspace.active ? "true" : undefined}
                    disabled={workspace.active || busy || Boolean(preview)}
                    onClick={() => void switchWorkspace(workspace.id)}
                  >
                    <span>{workspace.name}</span>
                    {workspace.active && <small>Current</small>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {busy && <p className="local-data-feedback" role="status">Working with the local workspace…</p>}
        {error && <p className="local-data-feedback local-data-error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
