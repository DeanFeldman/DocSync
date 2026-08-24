"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.7 exposes section-aware header and footer Layout contracts", () => {
  const types = read("apps/web/src/types.ts");
  const utils = read("apps/web/src/editorUtils.ts");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(types, /\| "header_paragraph"/);
  assert.match(types, /\| "footer_paragraph"/);
  assert.match(types, /header_footer_type\?: HeaderFooterType/);
  assert.match(types, /linked_section_indexes\?: number\[\]/);
  assert.match(utils, /location\.header_footer_type/);
  assert.match(utils, /location\.linked_section_indexes/);
  assert.match(experience, /"Header" : "Footer"/);
  assert.match(experience, /`\$\{region\}.*Section \$\{item\.section_index \+ 1\}.*\$\{variant\}.*Paragraph/);
  assert.doesNotMatch(experience, /linkedContentExplanation/);
});

test("header and footer blocks are button-selectable in the Word preview", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.match(overlay, /element_type === "header_paragraph"/);
  assert.match(overlay, /element_type === "footer_paragraph"/);
  assert.match(overlay, /data-element-id=\{region\.element_id\}/);
  assert.match(overlay, /onClick=\{\(event\) => pointerIntent\(region, event\)\}/);
  assert.match(experience, /setWorkspaceMode\("layout"\)/);
  assert.doesNotMatch(experience, /setWorkspaceMode\("edit"\)/);
  assert.doesNotMatch(experience, /groupStructuredBlocks|LayoutFallbackBlock/);
  assert.doesNotMatch(styles, /structured-block-group|layout-fallback/);
});

test("header and footer editing supports soft line breaks within one Word block", () => {
  const editor = read("apps/web/src/InlineLayoutEditor.tsx");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(editor, /docsyncSoftLineBreak/);
  assert.match(editor, /insertText\(range\.index, "\\n", "user"\)/);
  assert.match(editor, /aria-multiline", "true"/);
  assert.match(editor, /replace\(\/\\r\\n\?\/g, "\\n"\)/);
  assert.match(experience, /"header_paragraph"/);
  assert.match(experience, /"footer_paragraph"/);
  assert.match(experience, /disabled=\{\["table_paragraph", "header_paragraph", "footer_paragraph"\]/);
});

test("preview and selected Layout context expose header/footer location metadata", () => {
  const types = read("apps/web/src/types.ts");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(types, /interface PreviewChange[\s\S]*section_index\?: number/);
  assert.match(types, /interface PreviewChange[\s\S]*linked_sections\?: number\[\]/);
  assert.match(experience, /locationLabel\(change\)/);
  assert.match(experience, /className="preview-linked-sections"/);
  assert.match(experience, /Linked sections:/);
  assert.match(experience, /locationLabel\(selectedBlock\)/);
});
