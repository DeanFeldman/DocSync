import { useEffect, useRef, useState } from "react";
import {
  absoluteApiUrl, fetchDocumentVersions, restoreDocumentVersion, versionDownloadUrl,
} from "./api";
import { useConfirmation } from "./ConfirmationDialog";
import type { DocumentSummary, DocumentVersion, DocumentVersionRestoreResponse } from "./types";

interface Props {
  document: DocumentSummary;
  onClose: () => void;
  onRestored: (result: DocumentVersionRestoreResponse) => void;
}

export default function DocumentVersionHistory({ document, onClose, onRestored }: Props) {
  const confirm = useConfirmation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [restoring, setRestoring] = useState("");
  const currentVersion = document.current_version_id ?? document.version_id;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setVersions(null);
    setHistoryError("");
    void fetchDocumentVersions(document.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setVersions(result.versions);
    }).catch((cause) => {
      if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [document.id, currentVersion]);

  async function restore(version: DocumentVersion) {
    if (!(await confirm({
      title: `Restore version ${version.version_number}?`,
      message: "DocSync will create a new current version. Save any open edits in this file first.",
      action: "Restore version",
    }))) return;

    setRestoring(version.id);
    setHistoryError("");
    try {
      onRestored(await restoreDocumentVersion(document.id, version.id, currentVersion));
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring("");
    }
  }

  return <dialog ref={dialogRef} className="workspace-confirmation version-history-dialog"
    aria-labelledby="version-history-title" aria-busy={Boolean(restoring)}
    onCancel={(event) => {
      event.preventDefault();
      if (!restoring) onClose();
    }}
    onClick={(event) => {
      if (event.target === event.currentTarget && !restoring) onClose();
    }}>
    <div className="workspace-confirmation-content">
      <h2 id="version-history-title">Version history</h2>
      <p>{document.name}</p>
      <div className="version-history-list">
        {historyError ? <p role="alert">{historyError}</p> : versions === null && <p role="status">Loading versions…</p>}
        {versions?.map((version) => <article
          className={`version-history-item${version.is_current ? " current" : ""}`} key={version.id}>
          <span>
            <strong>Version {version.version_number}{version.is_current ? " · Current" : ""}</strong>
            <small>{new Date(version.created_at).toLocaleString()}</small>
            {version.restored_from_version_number != null && <small>Restored from version {version.restored_from_version_number}</small>}
          </span>
          <div className="version-history-actions">
            <a href={version.download_url ? absoluteApiUrl(version.download_url) : versionDownloadUrl(version.id)} download>Download</a>
            {!version.is_current && <button type="button" disabled={Boolean(restoring)}
              onClick={() => void restore(version)}>{restoring === version.id ? "Restoring…" : "Restore"}</button>}
          </div>
        </article>)}
      </div>
      <div className="workspace-confirmation-actions">
        <button type="button" className="quiet-button" autoFocus disabled={Boolean(restoring)} onClick={onClose}>Close</button>
      </div>
    </div>
  </dialog>;
}
