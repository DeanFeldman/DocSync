"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.7 exposes section-aware header and footer editor contracts", () => {
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
  assert.match(experience, /`\$\{region\} · Section \$\{item\.section_index \+ 1\} · \$\{variant\} · Paragraph/);
  assert.match(experience, /Shared with \$\{block\.section_indexes\.length\} sections/);
});

test("header and footer blocks are grouped, keyboard-selectable, and explain links", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.match(experience, /function groupStructuredBlocks/);
  assert.match(experience, /Document body/);
  assert.match(experience, /function linkedContentExplanation/);
  assert.match(experience, /role="button"/);
  assert.match(experience, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(experience, /focusEditorForElement\(block\.element_id\)/);
  assert.match(styles, /\.structured-block-group\.header/);
  assert.match(styles, /\.structured-block-group\.footer/);
  assert.match(styles, /:root\[data-theme="dark"\] \.structured-block-group/);
});

test("header and footer editing keeps the existing one-paragraph Quill boundary", () => {
  const editor = read("apps/web/src/QuillBlockEditor.tsx");

  assert.match(editor, /docsyncEnter:[\s\S]*handler: \(\) => false/);
  assert.match(editor, /aria-multiline", "false"/);
  assert.match(editor, /replace\(\/\\s\*\[\\r\\n\]\+\\s\*\/g, " "\)/);
  assert.match(editor, /"header_paragraph"/);
  assert.match(editor, /"footer_paragraph"/);
  assert.match(editor, /Choose a supported heading, body paragraph/);
});

test("preview and selected context expose header/footer location metadata", () => {
  const types = read("apps/web/src/types.ts");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(types, /interface PreviewChange[\s\S]*section_index\?: number/);
  assert.match(types, /interface PreviewChange[\s\S]*linked_sections\?: number\[\]/);
  assert.match(experience, /Document: \{document\.name\}/);
  assert.match(experience, /locationLabel\(change\)/);
  assert.match(experience, /linkedContentExplanation\(selectedBlock\)/);
});
