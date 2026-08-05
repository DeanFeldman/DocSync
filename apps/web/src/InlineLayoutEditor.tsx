import { useEffect, useRef, useState } from "react";
import type Quill from "quill";
import type { EditorBlock, QuillDelta, QuillDraft } from "./types";

let quillModulePromise: Promise<typeof import("quill")> | null = null;

function loadQuill() {
  if (!quillModulePromise) {
    quillModulePromise = Promise.all([
      import("quill"),
      import("quill/dist/quill.snow.css"),
    ]).then(([module]) => module);
  }
  return quillModulePromise;
}

export type InlineEditorCommand =
  | { id: number; action: "bold" | "italic" | "underline" }
  | { id: number; action: "heading"; value: number | false }
  | { id: number; action: "list"; value: "ordered" | "bullet" | false }
  | { id: number; action: "align"; value: "" | "center" | "right" | "justify" }
  | { id: number; action: "indent"; value: -1 | 1 }
  | { id: number; action: "undo" | "redo" };

interface InlineLayoutEditorProps {
  block: EditorBlock;
  value: QuillDelta;
  resetToken: number;
  caretFraction: number;
  command: InlineEditorCommand | null;
  disabled?: boolean;
  onChange: (draft: QuillDraft) => void;
  onExit: () => void;
}

function plainText(delta: QuillDelta): string {
  return delta.ops
    .map((operation) =>
      typeof operation.insert === "string" ? operation.insert : "",
    )
    .join("")
    .replace(/\n$/, "");
}

export default function InlineLayoutEditor({
  block,
  value,
  resetToken,
  caretFraction,
  command,
  disabled = false,
  onChange,
  onExit,
}: InlineLayoutEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const onChangeRef = useRef(onChange);
  const onExitRef = useRef(onExit);
  const lastRangeRef = useRef({ index: 0, length: 0 });
  const handledCommandRef = useRef(0);
  const disabledRef = useRef(disabled);
  const [editorStatus, setEditorStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");

  onChangeRef.current = onChange;
  onExitRef.current = onExit;
  disabledRef.current = disabled;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let quill: Quill | null = null;
    let frame: number | null = null;
    let handleTextChange: (
      delta: unknown,
      oldDelta: unknown,
      source: string,
    ) => void = () => undefined;
    let handleSelectionChange: (
      range: { index: number; length: number } | null,
    ) => void = () => undefined;
    let handlePaste: (event: ClipboardEvent) => void = () => undefined;
    let handleKeyDown: (event: KeyboardEvent) => void = () => undefined;
    const importStarted = performance.now();
    setEditorStatus("loading");

    void loadQuill().then(({ default: QuillConstructor }) => {
      if (cancelled || hostRef.current !== host) return;
      const initializationStarted = performance.now();
      console.info("docsync.quill_import_timing", {
        element_id: block.element_id,
        duration_ms: Number((initializationStarted - importStarted).toFixed(2)),
      });
      host.replaceChildren();
      const editor = document.createElement("div");
      host.appendChild(editor);
      quill = new QuillConstructor(editor, {
      theme: "snow",
      modules: {
        toolbar: false,
        history: { delay: 450, maxStack: 100, userOnly: true },
        keyboard: {
          bindings: {
            docsyncInlineEnter: { key: "Enter", handler: () => false },
          },
        },
      },
      });
      quillRef.current = quill;
      quill.setContents(value as never, "silent");
      quill.history.clear();
      quill.enable(!disabledRef.current);
      quill.root.dataset.inlineEditorElementId = block.element_id;
      quill.root.setAttribute(
      "aria-label",
      `Edit ${block.element_type.replaceAll("_", " ")}, paragraph ${block.paragraph_index + 1}`,
      );
      quill.root.setAttribute("aria-multiline", "false");

      function publish() {
        if (!quill) return;
        const delta = quill.getContents() as unknown as QuillDelta;
        onChangeRef.current({ delta, text: plainText(delta) });
      }

      handleTextChange = (_delta, _oldDelta, source) => {
        if (source === "user") publish();
      };

      handleSelectionChange = (range) => {
        if (range) lastRangeRef.current = range;
      };

      handlePaste = (event) => {
      if (disabledRef.current || !quill) return;
      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      if (!/[\r\n]/.test(pastedText)) return;
      event.preventDefault();
      const flattened = pastedText.replace(/\s*[\r\n]+\s*/g, " ").trim();
      const range = quill.getSelection(true) ?? lastRangeRef.current;
      if (range.length) quill.deleteText(range.index, range.length, "user");
      quill.insertText(range.index, flattened, "user");
      quill.setSelection(range.index + flattened.length, 0, "silent");
      };

      handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onExitRef.current();
      };

      quill.on("text-change", handleTextChange);
      quill.on("selection-change", handleSelectionChange);
      quill.root.addEventListener("paste", handlePaste, true);
      quill.root.addEventListener("keydown", handleKeyDown, true);

      frame = window.requestAnimationFrame(() => {
      if (quillRef.current !== quill || disabledRef.current || !quill) return;
      const textLength = Math.max(0, quill.getLength() - 1);
      const index = Math.min(
        textLength,
        Math.max(0, Math.round(textLength * Math.min(1, Math.max(0, caretFraction)))),
      );
      lastRangeRef.current = { index, length: 0 };
      quill.focus();
      quill.setSelection(index, 0, "silent");
      });
      setEditorStatus("ready");
      console.info("docsync.editor_initialization_timing", {
        element_id: block.element_id,
        duration_ms: Number(
          (performance.now() - initializationStarted).toFixed(2),
        ),
      });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setEditorStatus("error");
      console.error("docsync.editor_initialization_failed", error);
    });

    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      quill?.off("text-change", handleTextChange);
      quill?.off("selection-change", handleSelectionChange);
      quill?.root.removeEventListener("paste", handlePaste, true);
      quill?.root.removeEventListener("keydown", handleKeyDown, true);
      quill?.disable();
      if (quillRef.current === quill) quillRef.current = null;
      host.replaceChildren();
    };
  }, [block.element_id, resetToken]);

  useEffect(() => {
    quillRef.current?.enable(!disabled);
  }, [disabled]);

  useEffect(() => {
    const quill = quillRef.current;
    if (!quill || !command || handledCommandRef.current === command.id || disabled) {
      return;
    }
    handledCommandRef.current = command.id;
    const range = quill.getSelection() ?? lastRangeRef.current;
    if (command.action === "undo") {
      quill.history.undo();
    } else if (command.action === "redo") {
      quill.history.redo();
    } else if (["bold", "italic", "underline"].includes(command.action)) {
      const current = quill.getFormat(range)[command.action];
      quill.format(command.action, !current, "user");
    } else if (command.action === "heading") {
      quill.formatLine(0, quill.getLength(), "header", command.value, "user");
    } else if (command.action === "list") {
      quill.formatLine(0, quill.getLength(), "list", command.value, "user");
    } else if (command.action === "align") {
      quill.formatLine(0, quill.getLength(), "align", command.value || false, "user");
    } else if (command.action === "indent") {
      const current = Number(quill.getFormat(0, quill.getLength()).indent ?? 0);
      quill.formatLine(
        0,
        quill.getLength(),
        "indent",
        Math.max(0, current + command.value) || false,
        "user",
      );
    }
    const delta = quill.getContents() as unknown as QuillDelta;
    onChangeRef.current({ delta, text: plainText(delta) });
    quill.focus();
    quill.setSelection(range.index, range.length, "silent");
  }, [command, disabled]);

  return (
    <div
      className="inline-layout-editor"
      data-element-id={block.element_id}
      role="group"
      aria-label={`Inline editor for ${block.element_type.replaceAll("_", " ")}`}
    >
      <div ref={hostRef} className="inline-layout-editor-host" />
      {editorStatus !== "ready" && (
        <span className="inline-layout-editor-status" role="status">
          {editorStatus === "error"
            ? "The editor could not start. The document preview remains available."
            : "Preparing editor…"}
        </span>
      )}
    </div>
  );
}
