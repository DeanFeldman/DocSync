import { FormEvent, useEffect, useMemo, useState } from "react";
import { wordDifferenceSpans } from "./editorUtils";

import {
  addEditBatchOperation,
  clearEditBatch,
  createEditBatch,
  fetchDraftEditBatch,
  findReplaceSearch,
  generateEditBatch,
  previewEditBatch,
  removeEditBatchOperation,
  setEditBatchOccurrenceSelection,
  updateEditBatchOperation,
} from "./api";
import type {
  DocumentSetResponse,
  EditBatch,
  EditBatchOperation,
  EditBatchOperationInput,
  EditBatchPreview,
  EditorGenerationResponse,
  FindReplaceOccurrence,
  FindReplaceOccurrenceTarget,
  FindReplaceSearchOptions,
  FindReplaceSearchResponse,
} from "./types";

export const BATCH_UPDATED_EVENT = "docsync:batch-updated";

interface FindReplacePanelProps {
  documentSet: DocumentSetResponse;
  activeDocumentId: string;
  panel: "find" | "pending" | null;
  onPanelChange: (panel: "find" | "pending" | null) => void;
  onPendingCountChange: (count: number) => void;
  onGenerationQueued: (job: EditorGenerationResponse) => void;
  onOpenOccurrence: (occurrence: FindReplaceOccurrence) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The batch request failed.";
}

function occurrenceTarget(item: FindReplaceOccurrence): FindReplaceOccurrenceTarget {
  return {
    occurrence_id: item.occurrence_id,
    segment_id: item.segment_id,
    document_id: item.document_id,
    version_id: item.version_id,
    element_id: item.element_id,
    part_path: item.part_path,
    structure_type: item.structure_type,
    match_start: item.match_start,
    match_end: item.match_end,
    matched_text: item.matched_text,
    location: item.location,
    editable: item.editable,
    read_only_reason: item.read_only_reason,
  };
}

function operationInput(
  operation: EditBatchOperation,
  options: { replacementText?: string; enabled?: boolean } = {},
): EditBatchOperationInput {
  return {
    operation_type: operation.operation_type,
    label: operation.label,
    replacement_text:
      options.replacementText ?? operation.replacement_text ?? null,
    find_request: operation.find_request,
    editor_request: operation.editor_request,
    enabled: options.enabled ?? operation.enabled,
    occurrences: operation.occurrences.map((item) => ({
      occurrence_id: item.occurrence_id,
      segment_id: item.segment_id,
      document_id: item.document_id,
      version_id: item.base_version_id,
      element_id: item.element_id,
      part_path: item.part_path,
      structure_type: item.structure_type,
      match_start: item.match_start,
      match_end: item.match_end,
      matched_text: item.matched_text,
      location: item.location,
      editable: item.editable,
      read_only_reason: item.read_only_reason,
    })),
  };
}

export default function FindReplacePanel({
  documentSet,
  activeDocumentId,
  panel,
  onPanelChange,
  onPendingCountChange,
  onGenerationQueued,
  onOpenOccurrence,
}: FindReplacePanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeComments, setIncludeComments] = useState(false);
  const [includeTracked, setIncludeTracked] = useState(false);
  const [scope, setScope] = useState<"all" | "current" | "selected">("all");
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [selectedDocuments, setSelectedDocuments] = useState<Set<string>>(
    () => new Set(documentSet.documents.map((item) => item.id)),
  );
  const [result, setResult] = useState<FindReplaceSearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<EditBatch | null>(null);
  const [preview, setPreview] = useState<EditBatchPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [replacementDrafts, setReplacementDrafts] = useState<Record<string, string>>({});
  const [action, setAction] = useState("");
  const [error, setError] = useState("");

  async function refreshBatch() {
    try {
      setBatch(await fetchDraftEditBatch(documentSet.id));
    } catch (caught) {
      setError(message(caught));
    }
  }

  useEffect(() => {
    setSelectedDocuments(new Set(documentSet.documents.map((item) => item.id)));
    setResult(null);
    setSelected(new Set());
    setPreview(null);
    void refreshBatch();
  }, [documentSet.id]);

  useEffect(() => onPendingCountChange(batch?.operation_count ?? 0), [batch?.operation_count, onPendingCountChange]);

  useEffect(() => {
    const refresh = () => void refreshBatch();
    window.addEventListener(BATCH_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(BATCH_UPDATED_EVENT, refresh);
  }, [documentSet.id]);

  const groupedResults = useMemo(() => {
    const groups = new Map<string, FindReplaceOccurrence[]>();
    for (const item of result?.results ?? []) {
      const group = groups.get(item.document_name) ?? [];
      group.push(item);
      groups.set(item.document_name, group);
    }
    return Array.from(groups.entries());
  }, [result]);

  const selectedEditableCount = (result?.results ?? []).filter(
    (item) => item.editable && selected.has(item.occurrence_id),
  ).length;

  function searchOptions(): FindReplaceSearchOptions {
    return {
      query,
      document_ids: scope === "all" ? undefined : Array.from(selectedDocuments),
      match_case: matchCase,
      whole_word: wholeWord,
      include_comments: includeComments,
      include_historical_tracked_text: includeTracked,
    };
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || selectedDocuments.size === 0) return;
    setAction("search");
    setError("");
    setPreview(null);
    try {
      const response = await findReplaceSearch(documentSet.id, searchOptions());
      setResult(response);
      setSelected(
        new Set(
          response.results
            .filter((item) => item.editable)
            .map((item) => item.occurrence_id),
        ),
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleAddOperation() {
    if (!result || selectedEditableCount === 0) return;
    setAction("add");
    setError("");
    try {
      const draft = batch ?? (await createEditBatch(documentSet.id));
      const selectedResults = result.results.filter(
        (item) => item.editable && selected.has(item.occurrence_id),
      );
      const updated = await addEditBatchOperation(draft.id, {
        operation_type: "find_replace",
        label: `Replace “${query}”`,
        replacement_text: replacement,
        find_request: searchOptions(),
        occurrences: selectedResults.map(occurrenceTarget),
        enabled: true,
      });
      setBatch(updated);
      setPreview(null);
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleToggle(operation: EditBatchOperation) {
    if (!batch) return;
    setAction(operation.id);
    setError("");
    try {
      setBatch(
        await updateEditBatchOperation(
          batch.id,
          operation.id,
          operationInput(operation, { enabled: !operation.enabled }),
        ),
      );
      setPreview(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleSaveReplacement(operation: EditBatchOperation) {
    if (!batch) return;
    setAction(operation.id);
    setError("");
    try {
      const value = replacementDrafts[operation.id] ?? operation.replacement_text ?? "";
      setBatch(
        await updateEditBatchOperation(
          batch.id,
          operation.id,
          operationInput(operation, { replacementText: value }),
        ),
      );
      setPreview(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleRemove(operationId: string) {
    if (!batch) return;
    setAction(operationId);
    setError("");
    try {
      await removeEditBatchOperation(batch.id, operationId);
      await refreshBatch();
      setPreview(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleOccurrenceToggle(occurrenceRowId: string, selected: boolean) {
    if (!batch) return;
    setAction(occurrenceRowId);
    setError("");
    try {
      setBatch(
        await setEditBatchOccurrenceSelection(
          batch.id,
          occurrenceRowId,
          selected,
        ),
      );
      setPreview(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleClear() {
    if (!batch) return;
    setAction("clear");
    setError("");
    try {
      await clearEditBatch(batch.id);
      setBatch(null);
      setPreview(null);
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handlePreviewBatch() {
    if (!batch) return;
    setAction("preview");
    setError("");
    try {
      const response = await previewEditBatch(batch.id);
      setPreview(response);
      setPreviewOpen(true);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  async function handleApplyBatch() {
    if (!batch || preview?.status !== "ready") return;
    setAction("apply");
    setError("");
    try {
      const queued = await generateEditBatch(batch.id);
      onGenerationQueued(queued);
      setBatch(null);
      setPreview(null);
      setPreviewOpen(false);
      onPanelChange(null);
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setAction("");
    }
  }

  return (
    <section className={`find-replace-panel ${panel ? "open" : ""} ${panel ?? ""}`}>

      {panel && (
        <div className="find-replace-workspace" aria-label="Find and replace across document set">
          <header>
            <div>
              {panel === "find" && <p className="eyebrow">Complete text inventory</p>}
              <h2>{panel === "find" ? "Find & Replace" : "Pending changes"}</h2>
            </div>
            <button type="button" className="quiet-button" onClick={() => onPanelChange(null)}>
              Close
            </button>
          </header>

          {error && <div className="batch-error" role="alert">{error}</div>}

          <form className="find-replace-form" onSubmit={handleSearch}>
            <label>
              Find
              <input value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label>
              Replace with <small>(leave empty to delete)</small>
              <input value={replacement} onChange={(event) => setReplacement(event.target.value)} />
            </label>
            <fieldset className="find-replace-options">
              <legend>Match options</legend>
              <label><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /> Match case</label>
              <label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} /> Whole word</label>
            </fieldset>
            <button type="button" className="more-options-button" onClick={() => setMoreOptionsOpen((open) => !open)}>More options {moreOptionsOpen ? "▴" : "▾"}</button>
            {moreOptionsOpen && <div className="find-replace-more-options"><label><input type="checkbox" checked={includeComments} onChange={(event) => setIncludeComments(event.target.checked)} /> Include comments</label><label><input type="checkbox" checked={includeTracked} onChange={(event) => setIncludeTracked(event.target.checked)} /> Include tracked deletions</label></div>}
            <fieldset className="find-replace-scope">
              <legend>Document scope</legend>
              <div className="find-replace-scope-shortcuts">
                <button className={scope === "all" ? "active" : ""}
                  type="button"
                  onClick={() => { setScope("all"); setSelectedDocuments(new Set(documentSet.documents.map((item) => item.id))); }}
                >
                  All documents
                </button>
                <button className={scope === "current" ? "active" : ""}
                  type="button"
                  onClick={() => { setScope("current"); setSelectedDocuments(new Set(activeDocumentId ? [activeDocumentId] : [])); }}
                  disabled={!activeDocumentId}
                >
                  Current document
                </button>
                <button className={scope === "selected" ? "active" : ""} type="button" onClick={() => setScope("selected")}>Selected documents</button>
              </div>
              {scope === "selected" && documentSet.documents.map((document) => (
                <label key={document.id}>
                  <input
                    type="checkbox"
                    checked={selectedDocuments.has(document.id)}
                    onChange={(event) => {
                      setSelectedDocuments((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(document.id);
                        else next.delete(document.id);
                        return next;
                      });
                    }}
                  />
                  {document.name}
                </label>
              ))}
            </fieldset>
            <button type="submit" className="primary-button" disabled={!query.trim() || !selectedDocuments.size || Boolean(action)}>
              {action === "search" ? "Searching every structure…" : "Find all occurrences"}
            </button>
          </form>

          {result && (
            <section className="find-replace-results" aria-live="polite">
              <header>
                <div>
                  <strong>{result.result_count} occurrences across {result.document_count} documents</strong>
                  <span>{result.editable_count} editable · {result.read_only_count} read-only</span>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedEditableCount === result.editable_count && result.editable_count > 0}
                    onChange={(event) => setSelected(new Set(
                      event.target.checked
                        ? result.results.filter((item) => item.editable).map((item) => item.occurrence_id)
                        : [],
                    ))}
                  />
                  Select all editable
                </label>
              </header>
              {groupedResults.map(([documentName, occurrences]) => (
                <section className="find-replace-document" key={documentName}>
                  <h3>{documentName} <span>{occurrences.length}</span></h3>
                  {occurrences.map((item) => (
                    <div className={`find-replace-occurrence ${item.read_only ? "locked" : ""}`} key={item.occurrence_id}>
                      <input
                        aria-label={`Select occurrence in ${item.document_name}`}
                        type="checkbox"
                        disabled={!item.editable}
                        checked={selected.has(item.occurrence_id)}
                        onChange={(event) => setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item.occurrence_id);
                          else next.delete(item.occurrence_id);
                          return next;
                        })}
                      />
                      <span>
                        {item.context_before}<mark>{item.matched_text}</mark>{item.context_after}
                        <small>{item.location_label} · {item.structure_type.replaceAll("_", " ")}</small>
                        {item.read_only_reason && <em>{item.read_only_reason}</em>}
                      </span>
                      <button type="button" onClick={() => onOpenOccurrence(item)}>
                        {item.revision_id ? "Open occurrence" : "Open document"}
                      </button>
                    </div>
                  ))}
                </section>
              ))}
              <button type="button" className="primary-button" onClick={() => void handleAddOperation()} disabled={!selectedEditableCount || Boolean(action)}>
                {action === "add" ? "Adding…" : `Add ${selectedEditableCount} replacements to pending changes`}
              </button>
            </section>
          )}

          <section className="pending-batch" aria-label="Pending changes batch">
            <header>
              <div><p>{batch?.operation_count ?? 0} operations · {batch?.operations.reduce((total, operation) => total + (operation.occurrence_count || operation.editor_request?.targets.length || 0), 0) ?? 0} locations · {batch?.affected_document_count ?? 0} documents</p></div>
              {batch && <button type="button" className="quiet-button" onClick={() => void handleClear()} disabled={Boolean(action)}>Clear batch</button>}
            </header>
            {!batch || batch.operations.length === 0 ? (
              <p className="pending-batch-empty">No pending operations. Find text or add a reviewed editor change.</p>
            ) : (
              <>
                <div className="pending-operation-list">
                  {batch.operations.map((operation) => (
                    <article className={!operation.enabled ? "disabled" : ""} key={operation.id}>
                      <header>
                        <div>
                          <strong>{operation.label || (operation.operation_type === "find_replace" ? "Find & replace" : "Editor replacement")}</strong>
                          <span>{operation.occurrence_count || operation.editor_request?.targets.length || 0} locations · {operation.document_count} documents</span>
                        </div>
                        <label><input type="checkbox" checked={operation.enabled} onChange={() => void handleToggle(operation)} /> Enabled</label>
                      </header>
                      {operation.operation_type === "find_replace" && (
                        <div className="pending-replacement-edit">
                          <input
                            aria-label="Replacement text"
                            value={replacementDrafts[operation.id] ?? operation.replacement_text ?? ""}
                            onChange={(event) => setReplacementDrafts((current) => ({ ...current, [operation.id]: event.target.value }))}
                          />
                          <button type="button" onClick={() => void handleSaveReplacement(operation)} disabled={action === operation.id}>Save</button>
                        </div>
                      )}
                      <details>
                        <summary>Inspect operation</summary>
                        {operation.occurrences.map((item) => (
                          <label className="pending-occurrence" key={item.id}>
                            <input
                              type="checkbox"
                              checked={item.selected}
                              disabled={!item.editable || action === item.id}
                              onChange={(event) => void handleOccurrenceToggle(item.id, event.target.checked)}
                            />
                            <strong>{item.document_name}</strong>
                            <span>{item.matched_text} · {item.structure_type.replaceAll("_", " ")}</span>
                          </label>
                        ))}
                        {operation.editor_request && <p>{operation.editor_request.targets.length} reviewed editor targets</p>}
                      </details>
                      <button type="button" className="danger-link" onClick={() => void handleRemove(operation.id)} disabled={action === operation.id}>Remove</button>
                    </article>
                  ))}
                </div>
                <div className="pending-batch-actions">
                  <button type="button" className="primary-button" onClick={() => void handlePreviewBatch()} disabled={Boolean(action)}>Preview all changes</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {preview && previewOpen && (
        <div className="modal-backdrop batch-diff-backdrop" role="presentation">
          <section className="preview-dialog batch-diff-preview" role="dialog" aria-modal="true" aria-labelledby="batch-diff-title">
            <header className="preview-dialog-header"><div><p className="eyebrow">Pending changes</p><h2 id="batch-diff-title">Review every proposed change</h2><p>{preview.affected_location_count} locations across {preview.affected_document_count} documents</p></div><button type="button" className="dialog-close" onClick={() => setPreviewOpen(false)} aria-label="Back to changes">×</button></header>
            <div className="batch-diff-scroll">
              {preview.status !== "ready" ? <div className="batch-preview-summary conflicted"><strong>{preview.conflict_count} conflicts need attention</strong>{preview.conflicts.map((item, index) => <em key={`${item.code}-${index}`}>{item.message}</em>)}</div> : preview.documents.map((document) => (
                <section className="preview-document" key={document.document_id}><header><strong>{document.document_name}</strong><span>{document.change_count} changes</span></header>{document.changes.map((change, index) => <article className="comparison-card" key={`${change.operation_id}-${change.occurrence_id ?? change.element_id}-${index}`}><header><strong>{change.operation_type === "find_replace" ? "Find & replace" : "Editor edit"}</strong><small>{change.element_type.replaceAll("_", " ")} · Block {change.paragraph_index + 1}</small></header><div className="batch-diff-values"><div className="before"><small>Before</small><p>{change.before}</p></div><div className="after"><small>After</small><p>{wordDifferenceSpans(change.before, change.after).map((span, spanIndex) => <mark className={`difference-span ${span.kind}`} key={spanIndex}>{span.text}</mark>)}</p></div></div></article>)}</section>
              ))}
            </div>
            <footer className="preview-dialog-footer"><button type="button" className="quiet-button" onClick={() => { setPreviewOpen(false); onPanelChange("pending"); }}>Back to changes</button><button type="button" className="generate-version-button" onClick={() => void handleApplyBatch()} disabled={preview.status !== "ready" || Boolean(action)}>{action === "apply" ? "Submitting batch…" : "Apply all"}</button></footer>
          </section>
        </div>
      )}
    </section>
  );
}
