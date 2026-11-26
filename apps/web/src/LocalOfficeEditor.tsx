import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { absoluteApiUrl } from "./api";
import type { EditorGenerationResponse } from "./types";

async function read<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(absoluteApiUrl(path), options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "The local document editor request failed.");
  }
  return data;
}

type SaveScope = "shared" | "document";

const skipReasons = {
  ambiguous: "The same wording appears more than once.",
  detached: "This paragraph is excluded from shared edits.",
  protected: "The edit crosses protected Word content.",
  source_detached: "The source paragraph is excluded from shared edits.",
  source_protected: "The source edit crosses protected Word content.",
};

interface SkippedDocument {
  document_id: string;
  document_name: string;
  reasons: (keyof typeof skipReasons)[];
}

interface TableReviewFile {
  document_id: string;
  document_name: string;
  tables: { index: number; table_number: number; different_row: number }[];
}

interface TableReview {
  operation_id: string;
  files: TableReviewFile[];
}

function mergeTableReviews(existing: TableReview[], incoming: TableReview[]) {
  const known = new Set(existing.map((review) => review.operation_id));
  return [...existing, ...incoming.filter((review) => !known.has(review.operation_id))];
}

interface Props {
  documentId: string;
  toolbarTarget: HTMLElement | null;
  onGenerated: (result: EditorGenerationResponse) => void;
}

export default function LocalOfficeEditor({ documentId, toolbarTarget, onGenerated }: Props) {
  const [editor, setEditor] = useState<{ url: string; endpoint: string } | null>(null);
  const [scope, setScope] = useState<SaveScope>("shared");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveOperation, setSaveOperation] = useState("");
  const [skipped, setSkipped] = useState<SkippedDocument[]>([]);
  const [tableReviews, setTableReviews] = useState<TableReview[]>([]);
  const [reviewSelection, setReviewSelection] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [scopeBusy, setScopeBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [openError, setOpenError] = useState("");
  const [error, setError] = useState("");
  const onGeneratedRef = useRef(onGenerated);
  onGeneratedRef.current = onGenerated;

  useEffect(() => {
    const controller = new AbortController();
    void read<{ embed_url: string; version_id: string; save_scope: SaveScope }>(
      `/api/documents/${encodeURIComponent(documentId)}/onlyoffice/open`,
      { method: "POST", signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      setScope(result.save_scope);
      setEditor({ url: result.embed_url, endpoint: `/api/onlyoffice/${encodeURIComponent(result.version_id)}` });
    }).catch((cause) => {
      if (!controller.signal.aborted) setOpenError(cause instanceof Error ? cause.message : String(cause));
    });
    void read<TableReview[]>(
      `/api/documents/${encodeURIComponent(documentId)}/onlyoffice/table-reviews`,
      { signal: controller.signal },
    ).then((reviews) => {
      if (!controller.signal.aborted) setTableReviews((existing) => mergeTableReviews(existing, reviews));
    }).catch((cause) => {
      if (!controller.signal.aborted) setReviewError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [documentId, retry]);

  useEffect(() => {
    if (!editor) return;
    const controller = new AbortController();
    let lastOperation = "";
    let timer: number | undefined;
    async function check(endpoint: string) {
      try {
        const params = new URLSearchParams({ after_operation: lastOperation });
        const progress = await read<{
          save: (EditorGenerationResponse & {
            skipped_documents?: SkippedDocument[];
            table_review?: TableReviewFile[];
          }) | null;
          saving?: boolean;
          save_error?: string;
        }>(
          endpoint + "/save-status?" + params, { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setSaving(Boolean(progress.saving));
        setSaveError(progress.save_error ?? "");
        const { save } = progress;
        if (!save) return;
        lastOperation = save.generation_id;
        setSaveOperation(save.generation_id);
        setSkipped(save.skipped_documents ?? []);
        if (save.table_review?.length) {
          const review = { operation_id: save.generation_id, files: save.table_review };
          setTableReviews((existing) => mergeTableReviews(existing, [review]));
        }
        const related = (save.affected_documents ?? []).filter((document) => document.id !== documentId);
        setSaveMessage(related.length
          ? `Saved. Updated ${related.map((document) => document.name).join(", ")}.`
          : save.table_review?.length
            ? "Saved. Review tables with file-specific text."
            : "Saved. No shared paragraph updates in this save.");
        setError("");
        onGeneratedRef.current(save);
      } catch (error) {
        if (!controller.signal.aborted) {
          setSaving(false);
          setError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void check(endpoint), 750);
      }
    }
    void check(editor.endpoint);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [editor, documentId]);

  async function changeScope(nextScope: SaveScope) {
    if (!editor) return;
    setScopeBusy(true);
    setError("");
    try {
      const result = await read<{ save_scope: SaveScope }>(editor.endpoint + "/save-scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: nextScope }),
      });
      setScope(result.save_scope);
      setSaveMessage("");
      setSkipped([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScopeBusy(false);
    }
  }

  const tableReview = tableReviews[0];
  const tableReviewPopover = "table-review-" + documentId;

  async function resolveTableReview(deleteDocumentIds: string[]) {
    if (!tableReview) return;
    setReviewBusy(true);
    setReviewError("");
    try {
      const result = await read<EditorGenerationResponse | null>(
        "/api/onlyoffice/table-reviews/" + encodeURIComponent(tableReview.operation_id),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete_document_ids: deleteDocumentIds }),
        },
      );
      document.getElementById(tableReviewPopover)?.hidePopover();
      setTableReviews((reviews) => reviews.filter((review) => review.operation_id !== tableReview.operation_id));
      setReviewSelection([]);
      if (result) {
        const files = deleteDocumentIds.length === 1 ? "one file" : `${deleteDocumentIds.length} files`;
        setSaveMessage(`Deleted approved tables in ${files}.`);
        onGeneratedRef.current(result);
      } else {
        setSaveMessage("Kept the tables in matching files.");
      }
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReviewBusy(false);
    }
  }

  if (!editor) return <div className="local-office-empty">
    {openError ? <>
      <p role="alert">{openError}</p>
      <button type="button" className="quiet-button" onClick={() => {
        setOpenError("");
        setRetry((value) => value + 1);
      }}>Try again</button>
    </> : <p role="status">Opening ONLYOFFICE…</p>}
  </div>;

  return <>
    {toolbarTarget && createPortal(<div className="local-office-toolbar" aria-label="Document sync">
      <label>
        Apply wording changes to
        <select value={scope} disabled={scopeBusy || saving} onChange={(event) => void changeScope(event.target.value as SaveScope)}>
          <option value="shared">Matching files</option>
          <option value="document">This file only</option>
        </select>
      </label>
      <span className="local-office-save-status" role="status">
        {saving ? <>
          <span className="local-office-save-spinner" aria-hidden="true" />
          Saving…
        </> : saveError ? null : saveMessage ? <>
          <span key={saveOperation} className="local-office-save-check" aria-hidden="true">✓</span>
          {saveMessage}
        </> : scope === "shared"
          ? "Save to sync matching files."
          : "Save in ONLYOFFICE to update this file."}
      </span>
      {tableReview && <>
        <button type="button" className="quiet-button sync-skip-button" popoverTarget={tableReviewPopover}
          disabled={saving || reviewBusy}>
          Review table deletions ({tableReview.files.length})
        </button>
        <div id={tableReviewPopover} className="file-actions-popover sync-skip-list table-review-popover" popover="auto">
          <p>These tables contain file-specific text. Select the files where you want to delete them.</p>
          <ul>
            {tableReview.files.map((file) => <li key={file.document_id}>
              <label>
                <input
                  type="checkbox"
                  checked={reviewSelection.includes(file.document_id)}
                  disabled={reviewBusy}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setReviewSelection((selected) => checked
                      ? [...selected, file.document_id]
                      : selected.filter((id) => id !== file.document_id));
                  }}
                />
                <strong>{file.document_name}</strong>
              </label>
              {file.tables.map((table) => <span key={table.index}>
                Table {table.table_number} · row {table.different_row} differs
              </span>)}
            </li>)}
          </ul>
          <div className="table-review-actions">
            <button type="button" className="quiet-button" disabled={reviewBusy}
              onClick={() => void resolveTableReview([])}>Keep all</button>
            <button type="button" className="quiet-button" disabled={reviewBusy || !reviewSelection.length}
              onClick={() => void resolveTableReview(reviewSelection)}>Delete selected</button>
          </div>
          {reviewError && <p role="alert">{reviewError}</p>}
        </div>
      </>}
      {!saving && !saveError && skipped.length > 0 && <>
        <button type="button" className="quiet-button sync-skip-button"
          popoverTarget={`sync-skips-${documentId}`}>
          Skipped matches ({skipped.length})
        </button>
        <div id={`sync-skips-${documentId}`} className="file-actions-popover sync-skip-list" popover="auto">
          <ul>
            {skipped.map((file) => <li key={file.document_id}>
              <strong>{file.document_name}</strong>
              <span>{file.reasons.map((reason) => skipReasons[reason]).join(" ")}</span>
            </li>)}
          </ul>
        </div>
      </>}
    </div>, toolbarTarget)}
    {(saveError || error || (!tableReview && reviewError)) && <p className="local-office-error" role="alert">
      {saveError || error || reviewError}
    </p>}
    <iframe
      className="local-office-frame"
      src={editor.url}
      title="Local ONLYOFFICE editor"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
    />
  </>;
}
