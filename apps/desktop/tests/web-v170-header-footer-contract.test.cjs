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
  assert.match(
    experience,
    /This \$\{region\} is shared with sections \$\{sectionList\}/,
  );
});

test("header and footer blocks are grouped, button-selectable, and explain links", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.match(experience, /function groupStructuredBlocks/);
  assert.match(experience, /Document body/);
  assert.match(experience, /function linkedContentExplanation/);
  assert.match(experience, /<button[\s\S]*type="button"/);
  assert.match(experience, /onClick=\{\(\) => onSelect\(block\)\}/);
  assert.match(experience, /setWorkspaceMode\("layout"\)/);
  assert.doesNotMatch(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(styles, /\.structured-block-group\.header/);
  assert.match(styles, /\.structured-block-group\.footer/);
  assert.match(styles, /:root\[data-theme="dark"\] \.structured-block-group/);
});

test("header and footer editing keeps the existing one-paragraph Quill boundary", () => {
  const editor = read("apps/web/src/InlineLayoutEditor.tsx");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(editor, /docsyncInlineEnter:[\s\S]*handler: \(\) => false/);
  assert.match(editor, /aria-multiline", "false"/);
  assert.match(editor, /replace\(\/\\s\*\[\\r\\n\]\+\\s\*\/g, " "\)/);
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
