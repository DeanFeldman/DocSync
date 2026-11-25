import { useEffect, useState, type ReactNode } from "react";
import { absoluteApiUrl } from "./api";
import type { EditorGenerationResponse } from "./types";
import { useConfirmation } from "./ConfirmationDialog";
import { BATCH_UPDATED_EVENT } from "./FindReplacePanel";

async function read<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(absoluteApiUrl(path), options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "The local document editor request failed.");
  }
  return data;
}

interface Props {
  documentId: string;
  versionId: string;
  disabled: boolean;
  children: ReactNode;
  onGenerated: (result: EditorGenerationResponse) => void;
}

interface RelatedEdit {
  id: string;
  document_name: string;
  before: string;
  after: string;
}

interface Review {
  draft_sha256: string;
  changes: string[];
  truncated: boolean;
  related_edits: RelatedEdit[];
}

export default function LocalOfficeEditor({ documentId, versionId, disabled, children, onGenerated }: Props) {
  const confirm = useConfirmation();
  const [enabled, setEnabled] = useState(false);
  const [editorUrl, setEditorUrl] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [staged, setStaged] = useState<string[]>([]);
  const [stageMessage, setStageMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/onlyoffice/${encodeURIComponent(versionId)}`;

  useEffect(() => {
    const controller = new AbortController();
    void read<{ enabled: boolean }>("/api/onlyoffice", { signal: controller.signal })
      .then((value) => setEnabled(value.enabled)).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!editorUrl) return;
    const controller = new AbortController();
    async function check() {
      try {
        const draft = await read<{ draft_sha256: string | null }>(endpoint + "/draft", { signal: controller.signal });
        setSaved(draft.draft_sha256);
      } catch (error) {
        if (!controller.signal.aborted) setError(String(error));
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [editorUrl, endpoint]);

  async function open() {
    setBusy(true);
    setError("");
    try {
      const result = await read<{ embed_url: string }>(endpoint + "/open", { method: "POST" });
      setEditorUrl(result.embed_url);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function reviewSavedCopy() {
    setBusy(true);
    setError("");
    try {
      setReview(await read<Review>(endpoint + "/review"));
      setSelected([]);
      setStaged([]);
      setStageMessage("");
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  const currentReview = review?.draft_sha256 === saved ? review : null;

  async function stageRelated() {
    if (!currentReview || !selected.length) return;
    setBusy(true);
    setError("");
    setStageMessage("");
    try {
      const path = `/api/documents/${encodeURIComponent(documentId)}/onlyoffice/${encodeURIComponent(versionId)}/stage-related`;
      await read(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_sha256: currentReview.draft_sha256, target_ids: selected }),
      });
      setStaged([...staged, ...selected]);
      setSelected([]);
      setStageMessage("Selected edits are in Pending changes for review and apply.");
      window.dispatchEvent(new Event(BATCH_UPDATED_EVENT));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!currentReview || disabled) return;
    const reviewed = currentReview.draft_sha256;
    if (!(await confirm({
      title: "Apply the saved copy?",
      message: "This creates a new version of the current document from the last save in ONLYOFFICE.",
      action: "Create version",
    }))) return;
    setBusy(true);
    setError("");
    try {
      const path = `/api/documents/${encodeURIComponent(documentId)}/onlyoffice/${encodeURIComponent(versionId)}/apply`;
      const result = await read<EditorGenerationResponse>(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_sha256: reviewed }),
      });
      setEditorUrl("");
      onGenerated(result);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return <>{children}</>;

  return <>
    <div className="local-office-toolbar" aria-label="Local document editor">
      {editorUrl ? <>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => {
          setEditorUrl("");
          setSaved(null);
          setReview(null);
          setSelected([]);
          setStaged([]);
          setStageMessage("");
          setError("");
        }}>Back to Layout</button>
        <span role="status">{saved ? "Saved copy ready for review" : "Click Save in ONLYOFFICE to prepare a copy for review"}</span>
        {saved && <>
          <a className="quiet-button" href={absoluteApiUrl(endpoint + "/draft/download")} download>Download saved copy</a>
          {currentReview ? <button type="button" className="quiet-button" onClick={() => void apply()} disabled={busy || disabled}>Apply to this document</button>
            : <button type="button" className="quiet-button" onClick={() => void reviewSavedCopy()} disabled={busy}>Review saved copy</button>}
        </>}
      </> : <button type="button" className="quiet-button" onClick={() => void open()} disabled={busy || disabled}>Edit in ONLYOFFICE</button>}
    </div>
    {error && <p className="editor-operation-error" role="alert">{error}</p>}
    {editorUrl && currentReview && <section className="local-office-review" aria-label="Saved document changes">
      <strong>Text changes in the saved copy</strong>
      {currentReview.changes.length ? <pre>{currentReview.changes.join("\n")}</pre>
        : <p>No text changes detected. Review formatting in the document editor.</p>}
      {currentReview.truncated && <p>Download the saved copy to review the complete document.</p>}
      {currentReview.related_edits.length ? <fieldset className="local-office-related">
        <legend>Update matching paragraphs in other files</legend>
        {currentReview.related_edits.map((match) => <label key={match.id}>
          <input type="checkbox" checked={selected.includes(match.id) || staged.includes(match.id)}
            disabled={busy || staged.includes(match.id)} onChange={(event) => {
              setSelected(event.target.checked ? [...selected, match.id] : selected.filter(id => id !== match.id));
            }} />
          <span><strong>{match.document_name}</strong><br />{match.before}<br />→ {match.after}</span>
        </label>)}
        <button type="button" className="quiet-button" disabled={busy || !selected.length} onClick={() => void stageRelated()}>Add selected edits to Pending changes</button>
        {stageMessage && <p role="status">{stageMessage}</p>}
      </fieldset> : <p>No unambiguous matching paragraphs found in the other files.</p>}
    </section>}
    {editorUrl ? <iframe
      className="local-office-frame"
      src={editorUrl}
      title="Local ONLYOFFICE editor"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
    /> : children}
  </>;
}
