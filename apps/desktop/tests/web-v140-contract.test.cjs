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
  const desktop = read("apps/desktop/main.cjs");
  const preload = read("apps/desktop/preload.cjs");

  assert.match(index, /<script src="\/theme-bootstrap\.js"><\/script>/);
  assert.match(bootstrap, /docsync-theme/);
  assert.match(bootstrap, /prefers-color-scheme:\s*dark/);
  assert.match(bootstrap, /documentElement\.dataset\.theme/);
  assert.match(theme, /ThemePreference = "system" \| AppTheme/);
  assert.match(theme, /localStorage\.setItem\(THEME_STORAGE_KEY, preference\)/);
  assert.match(theme, /setThemePreference/);
  assert.match(app, /className="theme-selector"/);
  assert.match(app, /prefers-color-scheme: dark/);
  assert.match(desktop, /theme:get-preference/);
  assert.match(desktop, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
  assert.match(preload, /getThemePreference/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
});

test("controlled Word selection uses the central version-safe inline editor path", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");
  const types = read("apps/web/src/types.ts");

  assert.doesNotMatch(experience, /LayoutFallbackBlock|showLayoutStructure/);
  assert.match(overlay, /data-element-id=\{region\.element_id\}/);
  assert.match(experience, /function selectElementById/);
  assert.match(
    experience,
    /options\.sourceVersionId !== editorContent\.version_id/,
  );
  assert.match(experience, /selectBlock\(\s*block,/);
  assert.match(overlay, /region\.element_id === selectedElementId/);
  assert.match(experience, /setWorkspaceMode\("layout"\)/);
  assert.match(
    experience,
    /setInlineSelection\(remainInLayout \? selection : null\)/,
  );
  assert.doesNotMatch(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(types, /layout_regions\?: LayoutElementRegion\[\]/);
});
