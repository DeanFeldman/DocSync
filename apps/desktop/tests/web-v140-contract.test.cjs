"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("theme is applied before React and persists the explicit preference", () => {
  const index = read("apps/web/index.html");
  const bootstrap = read("apps/web/public/theme-bootstrap.js");
  const app = read("apps/web/src/App.tsx");
  const theme = read("apps/web/src/theme.ts");
  const styles = read("apps/web/src/styles.css");

  assert.match(index, /<script src="\/theme-bootstrap\.js"><\/script>/);
  assert.match(bootstrap, /docsync-theme/);
  assert.match(bootstrap, /prefers-color-scheme:\s*dark/);
  assert.match(bootstrap, /documentElement\.dataset\.theme/);
  assert.match(theme, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/);
  assert.match(app, /className="theme-toggle"/);
  assert.match(app, /aria-pressed=\{theme === "dark"\}/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /\.docsync-quill-toolbar \.ql-stroke/);
});

test("structured Layout selection uses the central version-safe editor path", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const types = read("apps/web/src/types.ts");

  assert.match(experience, /function LayoutFallbackBlock/);
  assert.match(experience, /function selectElementById/);
  assert.match(
    experience,
    /options\.sourceVersionId !== editorContent\.version_id/,
  );
  assert.match(experience, /selectBlock\(block,/);
  assert.match(experience, /aria-pressed=\{selected\}/);
  assert.match(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(experience, /focusEditorForElement\(block\.element_id\)/);
  assert.match(types, /layout_regions\?: LayoutElementRegion\[\]/);
});
