"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.5 table paragraphs have a paragraph-aware typed Layout contract", () => {
  const types = read("apps/web/src/types.ts");
  const utils = read("apps/web/src/editorUtils.ts");
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");

  assert.match(types, /\| "table_paragraph"/);
  assert.match(utils, /"table_paragraph"/);
  assert.match(experience, /Paragraph \$\{item\.paragraph_index \+ 1\}/);
  assert.match(overlay, /data-element-id=\{region\.element_id\}/);
  assert.match(experience, /locationLabel\(block\)/);
  assert.match(experience, /Source version/);
  assert.match(experience, /preview\.edit_mode\.replaceAll/);
});

test("Layout selection keeps and focuses the exact supported table paragraph inline", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");

  assert.doesNotMatch(experience, /LayoutFallbackBlock|showLayoutStructure/);
  assert.match(experience, /selectElementById\(intent\.elementId/);
  assert.match(overlay, /data-element-id=\{region\.element_id\}/);
  assert.match(experience, /block\.version_id !== editorContent\.version_id/);
  assert.match(experience, /setWorkspaceMode\("layout"\)/);
  assert.match(
    experience,
    /setInlineSelection\(remainInLayout \? selection : null\)/,
  );
  assert.doesNotMatch(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(experience, /block\.unsupported_reason/);
  assert.match(overlay, /region\.element_id === selectedElementId/);
});

test("inline Quill preserves soft line breaks without structural table edits", () => {
  const editor = read("apps/web/src/InlineLayoutEditor.tsx");

  assert.match(editor, /docsyncSoftLineBreak/);
  assert.match(editor, /insertText\(range\.index, "\\n", "user"\)/);
  assert.match(editor, /aria-multiline", "true"/);
  assert.match(editor, /replace\(\/\\r\\n\?\/g, "\\n"\)/);
  assert.match(editor, /quill\.history\.clear\(\)/);
  assert.match(editor, /quill\.history\.undo\(\)/);
  assert.match(editor, /quill\.history\.redo\(\)/);
  assert.match(editor, /loadQuill/);
  assert.match(editor, /import\("quill"\)/);
});

test("table paragraph active and read-only states remain explicit in dark mode", () => {
  const styles = read("apps/web/src/styles.css");

  assert.match(styles, /\.document-element\.table_paragraph\.selected/);
  assert.match(styles, /:root\[data-theme="dark"\] \.editor-block-card\.read-only/);
  assert.match(styles, /:root\[data-theme="dark"\] \.editor-block-card\.read-only/);
  assert.match(styles, /\.support-label\.read-only/);
});
