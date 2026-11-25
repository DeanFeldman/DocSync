import { useEffect, useState } from "react";
import {
  addEditBatchOperation,
  createEditBatch,
  fetchBlockTextRanges,
  fetchDraftEditBatch,
  updateEditBatchOperation,
} from "./api";
import { BATCH_UPDATED_EVENT, occurrenceTarget } from "./FindReplacePanel";
import type { EditBatch, EditorBlock, FindReplaceOccurrence } from "./types";

const rangeEditLabel = "Edit paragraph text";

function pendingRangeEdit(batch: EditBatch | null, range: FindReplaceOccurrence) {
  return batch?.operations.find((operation) =>
    operation.operation_type === "find_replace" &&
    operation.label === rangeEditLabel &&
    operation.occurrences.length === 1 &&
    operation.occurrences[0].occurrence_id === range.occurrence_id,
  );
}

export default function WordTextRanges({ block, documentSetId, pendingBatch }: {
  block: EditorBlock;
  documentSetId: string;
  pendingBatch: EditBatch | null;
}) {
  const [ranges, setRanges] = useState<FindReplaceOccurrence[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetchBlockTextRanges(block.version_id, block.element_id, controller.signal)
      .then(({ ranges }) => {
        if (!controller.signal.aborted) setRanges(ranges);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : "Could not open the paragraph.");
      });
    return () => controller.abort();
  }, [block.element_id, block.version_id]);

  async function stage(range: FindReplaceOccurrence, value: string) {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const batch = (await fetchDraftEditBatch(documentSetId)) ??
        (await createEditBatch(documentSetId, "Pending changes"));
      const existing = pendingRangeEdit(batch, range);
      const operation = {
        operation_type: "find_replace" as const,
        label: rangeEditLabel,
        replacement_text: value,
        find_request: { query: range.matched_text, match_case: true },
        occurrences: [occurrenceTarget(range)],
        enabled: true,
      };
      if (existing) {
        await updateEditBatchOperation(batch.id, existing.id, operation);
      } else {
        await addEditBatchOperation(batch.id, operation);
      }
      setStatus("Added to Pending Changes.");
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Could not stage the paragraph edit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="read-only-sidebar">
      {ranges?.some((range) => range.editable) ? (
        <p>Edit the text below, then review the proposed edits in Pending Changes.</p>
      ) : ranges && (
        <p>{block.unsupported_reason ?? "This area has no editable Word text."}</p>
      )}
      {!ranges && !error && <p role="status">Checking the paragraph…</p>}
      {ranges?.map((range, index) => {
        const id = range.occurrence_id;
        if (!range.editable) {
          return (
            <p key={id} title={range.read_only_reason ?? undefined}>
              <strong>{range.matched_text}</strong>
              <br />
              <small>{range.read_only_reason}</small>
            </p>
          );
        }
        const base = pendingRangeEdit(pendingBatch, range)?.replacement_text ?? range.matched_text;
        const value = values[id] ?? base;
        return (
          <div className="per-document-values" key={id}>
            <label>
              Text part {index + 1}
              <textarea
                rows={3}
                maxLength={20_000}
                value={value}
                onChange={(event) => {
                  const text = event.target.value;
                  setValues((current) => ({ ...current, [id]: text }));
                  setStatus("");
                }}
              />
            </label>
            <button
              type="button"
              className="quiet-button"
              disabled={saving || value === base}
              onClick={() => void stage(range, value)}
            >
              Stage text change
            </button>
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
