"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.8 exposes immutable render-map and normalized region contracts", () => {
  const types = read("apps/web/src/types.ts");
  const api = read("apps/web/src/api.ts");
  const backend = read("apps/api/app/render_map_service.py");

  assert.match(types, /export type RenderMapStatus/);
  assert.match(types, /"not_requested"/);
  assert.match(types, /"partial"/);
  assert.match(types, /interface RenderMapRegion extends LayoutElementRegion/);
  assert.match(types, /interactive: boolean/);
  assert.match(types, /read_only_reason\?: string \| null/);
  assert.match(api, /document-versions\/\$\{versionId\}\/render-map/);
  assert.match(backend, /RENDER_MAP_ENGINE = "docsync-contextual-pdf-map-v1"/);
  assert.match(backend, /"source_sha256"/);
  assert.match(backend, /"pdf_sha256"/);
  assert.match(backend, /settings\.render_map_confidence_threshold/);
  assert.match(backend, /Repeated PDF text could not be resolved safely/);
});

test("controlled Word preview supports zoom, fitting, visibility, and structure fallback", () => {
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.match(overlay, /aria-label="Zoom out"/);
  assert.match(overlay, /aria-label="Zoom level"/);
  assert.match(overlay, /aria-label="Zoom in"/);
  assert.match(overlay, />\s*Fit width\s*</);
  assert.match(overlay, />\s*Fit page\s*</);
  assert.match(overlay, /Show selectable areas/);
  assert.match(overlay, /Select from structure/);
  assert.match(overlay, /Preparing direct selection\.\.\./);
  assert.match(overlay, /Direct selection is available for supported areas/);
  assert.match(overlay, /Word preview available - direct selection unavailable/);
  assert.match(overlay, /IntersectionObserver/);
  assert.match(overlay, /ResizeObserver/);
  assert.match(overlay, /region\.x \* 100/);
  assert.match(overlay, /region\.version_id !== versionId/);
  assert.match(experience, /sourceLabel: "Word preview region"/);
  assert.match(experience, /selectElementById\(elementId/);
  assert.match(styles, /\.render-map-region\.interactive:hover/);
  assert.match(styles, /\.render-map-region\.read-only:hover/);
  assert.match(styles, /\.render-map-region\.selected/);
  assert.match(styles, /\.render-map-region:focus-visible/);
});

test("keyboard activation and read-only map targets preserve editor safety", () => {
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(overlay, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(overlay, /aria-disabled=\{!region\.interactive\}/);
  assert.match(overlay, /if \(region\.interactive\) onSelect\(region\)/);
  assert.match(experience, /options\.sourceVersionId !== editorContent\.version_id/);
  assert.match(experience, /if \(!block\.supported \|\| block\.read_only\)/);
  assert.match(experience, /setPendingBlockSelection\(block\)/);
  assert.match(experience, /setWorkspaceMode\("edit"\)/);
  assert.match(experience, /focusEditorForElement\(block\.element_id\)/);
});
