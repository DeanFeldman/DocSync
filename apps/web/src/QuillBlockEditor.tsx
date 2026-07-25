import {
  useEffect,
  useRef,
} from "react";
import Quill from "quill";
import "quill/dist/quill.snow.css";
import type {
  EditorBlock,
  QuillDelta,
} from "./types";

export interface QuillDraft {
  delta: QuillDelta;
  text: string;
}

interface QuillBlockEditorProps {
  block: EditorBlock | null;
  value: QuillDelta | null;
  resetToken: number;
  onChange: (draft: QuillDraft) => void;
}

function plainText(delta: QuillDelta): string {
  return delta.ops
    .map((operation) =>
      typeof operation.insert === "string" ? operation.insert : "",
    )
    .join("")
    .replace(/\n$/, "");
}

function toolbarControls(
  toolbar: HTMLDivElement | null,
  disabled: boolean,
) {
  toolbar
    ?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")
    .forEach((control) => {
      control.disabled = disabled;
      control.setAttribute("aria-disabled", String(disabled));
    });
}

function historyControls(
  undo: HTMLButtonElement | null,
  redo: HTMLButtonElement | null,
  quill: Quill,
  readOnly: boolean,
) {
  const states = [
    [undo, readOnly || quill.history.stack.undo.length === 0],
    [redo, readOnly || quill.history.stack.redo.length === 0],
  ] as const;
  states.forEach(([button, disabled]) => {
    if (!button) return;
    button.disabled = disabled;
    button.setAttribute("aria-disabled", String(disabled));
  });
}

export default function QuillBlockEditor({
  block,
  value,
  resetToken,
  onChange,
}: QuillBlockEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const redoRef = useRef<HTMLButtonElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const onChangeRef = useRef(onChange);
  const initialDeltaRef = useRef<QuillDelta | null>(value);

  onChangeRef.current = onChange;
  initialDeltaRef.current = value;

  useEffect(() => {
    const host = hostRef.current;
    const toolbar = toolbarRef.current;
    const undoButton = undoRef.current;
    const redoButton = redoRef.current;
    if (!host || !toolbar || !block) {
      toolbarControls(toolbar, true);
      return;
    }

    host.replaceChildren();
    const editor = document.createElement("div");
    host.appendChild(editor);

    const quill = new Quill(editor, {
      theme: "snow",
      placeholder: "Edit this block",
      modules: {
        toolbar,
        history: {
          delay: 500,
          maxStack: 100,
          userOnly: true,
        },
        keyboard: {
          bindings: {
            docsyncEnter: {
              key: "Enter",
              handler: () => false,
            },
          },
        },
      },
    });
    quillRef.current = quill;
    const readOnly = block.read_only || !block.supported;
    quill.enable(!readOnly);
    toolbarControls(toolbar, readOnly);

    const initial = initialDeltaRef.current ?? block.delta;
    quill.setContents(initial as never, "silent");
    quill.history.clear();
    quill.root.dataset.editorElementId = block.element_id;
    quill.root.setAttribute(
      "aria-label",
      `Edit ${block.element_type.replaceAll("_", " ")} ${block.paragraph_index + 1}`,
    );
    quill.root.setAttribute("aria-multiline", "false");
    if (readOnly) quill.root.setAttribute("aria-readonly", "true");
    historyControls(undoButton, redoButton, quill, readOnly);

    function handleTextChange(
      _delta: unknown,
      _oldDelta: unknown,
      source: string,
    ) {
      if (source !== "user") return;
      const delta = quill.getContents() as unknown as QuillDelta;
      onChangeRef.current({
        delta,
        text: plainText(delta),
      });
      historyControls(undoButton, redoButton, quill, readOnly);
    }

    function handleUndo() {
      quill.history.undo();
      historyControls(undoButton, redoButton, quill, readOnly);
    }

    function handleRedo() {
      quill.history.redo();
      historyControls(undoButton, redoButton, quill, readOnly);
    }

    function handlePaste(event: ClipboardEvent) {
      if (readOnly) return;
      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      if (!/[\r\n]/.test(pastedText)) return;

      event.preventDefault();
      const flattened = pastedText.replace(/\s*[\r\n]+\s*/g, " ").trim();
      const range = quill.getSelection(true) ?? {
        index: Math.max(0, quill.getLength() - 1),
        length: 0,
      };
      if (range.length > 0) {
        quill.deleteText(range.index, range.length, "user");
      }
      quill.insertText(range.index, flattened, "user");
      quill.setSelection(range.index + flattened.length, 0, "silent");
    }

    quill.on("text-change", handleTextChange);
    undoButton?.addEventListener("click", handleUndo);
    redoButton?.addEventListener("click", handleRedo);
    quill.root.addEventListener("paste", handlePaste, true);

    return () => {
      quill.off("text-change", handleTextChange);
      undoButton?.removeEventListener("click", handleUndo);
      redoButton?.removeEventListener("click", handleRedo);
      quill.root.removeEventListener("paste", handlePaste, true);
      quill.disable();
      if (quillRef.current === quill) quillRef.current = null;
      host.replaceChildren();
      toolbarControls(toolbar, true);
    };
  }, [block?.element_id, resetToken]);

  return (
    <section
      className={`quill-block-editor ${
        !block || block.read_only || !block.supported ? "is-disabled" : ""
      }`}
      aria-labelledby="quill-editor-title"
    >
      <div className="quill-editor-heading">
        <div>
          <p className="eyebrow">Structured editor</p>
          <h3 id="quill-editor-title">
            {block ? "Edit selected block" : "Select a block to edit"}
          </h3>
        </div>
        {block && (
          <code title={block.element_id}>
            {block.element_id.slice(0, 8)}
          </code>
        )}
      </div>

      <div
        ref={toolbarRef}
        className="docsync-quill-toolbar"
        role="toolbar"
        aria-label="Text editing and formatting"
      >
        <span className="ql-formats">
          <select className="ql-header" defaultValue="" aria-label="Heading level">
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
            <option value="">Normal</option>
          </select>
        </span>
        <span className="ql-formats">
          <button type="button" className="ql-bold" aria-label="Bold" />
          <button type="button" className="ql-italic" aria-label="Italic" />
          <button type="button" className="ql-underline" aria-label="Underline" />
        </span>
        <span className="ql-formats">
          <button
            type="button"
            className="ql-list"
            value="ordered"
            aria-label="Ordered list"
          />
          <button
            type="button"
            className="ql-list"
            value="bullet"
            aria-label="Bullet list"
          />
          <button
            type="button"
            className="ql-indent"
            value="-1"
            aria-label="Outdent"
          />
          <button
            type="button"
            className="ql-indent"
            value="+1"
            aria-label="Indent"
          />
        </span>
        <span className="ql-formats">
          <select className="ql-align" defaultValue="" aria-label="Alignment">
            <option value="">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
            <option value="justify">Justify</option>
          </select>
          <button
            type="button"
            className="ql-clean"
            aria-label="Clear formatting"
          />
        </span>
        <span className="ql-formats docsync-history-actions">
          <button
            ref={undoRef}
            type="button"
            className="editor-history-button"
            aria-label="Undo last text change"
            aria-keyshortcuts="Control+Z Meta+Z"
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            ref={redoRef}
            type="button"
            className="editor-history-button"
            aria-label="Redo last text change"
            aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
            title="Redo (Ctrl+Y)"
          >
            Redo
          </button>
        </span>
      </div>

      {/* Quill owns every child of its host; React must never render into it. */}
      {block ? (
        <div ref={hostRef} className="quill-editor-host" />
      ) : (
        <div className="quill-editor-placeholder" role="status">
          Choose a supported paragraph, heading, list item, or table cell from
          the document.
        </div>
      )}

      <p className="structure-safety-note">
        One stable Word block is edited at a time. Splitting, merging,
        reordering, and multi-line paste are intentionally disabled so the
        document mapping stays safe.
      </p>
      {block?.unsupported_reason && (
        <p className="block-diagnostic" role="note">
          <strong>Read-only:</strong> {block.unsupported_reason}
        </p>
      )}
    </section>
  );
}
