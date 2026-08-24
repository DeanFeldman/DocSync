"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.8 queues durable preview work and reports progressive readiness", () => {
  const main = read("apps/api/app/main.py");
  const service = read("apps/api/app/preview_job_service.py");
  const models = read("apps/api/app/models.py");
  const api = read("apps/web/src/api.ts");
  const types = read("apps/web/src/types.ts");

  assert.match(main, /document-versions\/\{version_id\}\/preview-jobs/);
  assert.match(main, /api\/preview-jobs\/\{job_id\}/);
  assert.match(main, /document-versions\/\{version_id\}\/preview/);
  assert.match(models, /class PreviewRenderJob/);
  assert.match(service, /PREVIEW_WORKER_COUNT = 1/);
  assert.match(service, /"pdf_ready"/);
  assert.match(service, /"render_map_ready"/);
  assert.match(service, /"starting_microsoft_word"/);
  assert.match(service, /"preparing_selectable_text"/);
  assert.match(api, /createPreviewJob/);
  assert.match(api, /fetchPreviewJob/);
  assert.match(types, /interface PreviewRenderJobResponse/);
});

test("controlled preview publishes pages, overlays, zoom, and structure fallback", () => {
  const overlay = read("apps/web/src/WordPreviewOverlay.tsx");
  const backend = read("apps/api/app/render_map_service.py");
  const styles = read("apps/web/src/styles.css");

  assert.doesNotMatch(overlay, /<iframe/);
  assert.match(overlay, /aria-label="Zoom out"/);
  assert.match(overlay, /aria-label="Zoom level"/);
  assert.match(overlay, /aria-label="Zoom in"/);
  assert.match(overlay, /Fit width/);
  assert.match(overlay, /Fit page/);
  assert.match(overlay, /Show selectable areas/);
  assert.match(overlay, /Select from structure/);
  assert.match(overlay, /Retry preview/);
  assert.match(overlay, /IntersectionObserver/);
  assert.match(overlay, /ResizeObserver/);
  assert.match(overlay, /region\.x \* 100/);
  assert.match(backend, /def _extract_pdf_structure/);
  assert.match(backend, /def _render_pdf_page/);
  assert.match(backend, /wait_for_render_map/);
  assert.match(backend, /Repeated PDF text could not be resolved safely/);
  assert.match(styles, /\.render-map-region\.interactive:hover/);
  assert.match(styles, /\.render-map-region\.read-only:hover/);
  assert.match(styles, /\.render-map-region\.selected/);
});

test("open workspaces fill the viewport and keep scrolling inside the preview", () => {
  const app = read("apps/web/src/App.tsx");
  const styles = read("apps/web/src/styles.css");

  assert.match(app, /classList\.toggle\("workspace-open", Boolean\(documentSet\)\)/);
  assert.match(styles, /body\.workspace-open[\s\S]*overflow: hidden/);
  assert.match(styles, /\.workspace-mode \.layout-iframe-shell[\s\S]*flex: 1/);
  assert.match(styles, /\.render-map-pages[\s\S]*overflow: auto/);
  assert.doesNotMatch(styles, /height: calc\(100vh - 390px\)/);
});

test("inline Quill enforces one paragraph and shares the central draft", () => {
  const inlineEditor = read("apps/web/src/InlineLayoutEditor.tsx");
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(inlineEditor, /docsyncInlineEnter/);
  assert.match(inlineEditor, /handler: \(\) => false/);
  assert.match(inlineEditor, /replace\(\/\\s\*\[\\r\\n\]\+\\s\*\/g, " "\)/);
  assert.match(inlineEditor, /event\.key !== "Escape"/);
  assert.match(inlineEditor, /quill\.history\.undo/);
  assert.match(inlineEditor, /quill\.history\.redo/);
  assert.match(inlineEditor, /import\("quill"\)/);
  assert.match(inlineEditor, /import\("quill\/dist\/quill\.snow\.css"\)/);
  assert.doesNotMatch(inlineEditor, /^import Quill from "quill"/m);
  assert.match(experience, /remainInLayout: true/);
  assert.match(experience, /setWorkspaceMode\("layout"\)/);
  assert.match(experience, /onDraftChange=\{handleDraftChange\}/);
  assert.match(experience, /setDraft\(nextDraft\)/);
  assert.match(experience, /setPendingBlockSelection\(\{/);
  assert.match(experience, /This draft may wrap differently/);
});

test("Layout exposes formatting, matching, preview, generation, and rerender", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const editorService = read("apps/api/app/editor_service.py");
  const app = read("apps/web/src/App.tsx");

  for (const label of [
    "Bold",
    "Italic",
    "Underline",
    "Heading level",
    "Numbered",
    "Bullets",
    "Outdent",
    "Indent",
    "Paragraph alignment",
    "Undo",
    "Redo",
    "Preview changes",
    "Generate new versions",
  ]) {
    assert.match(experience, new RegExp(label));
  }
  assert.match(experience, /layout-near-matches/);
  assert.match(experience, /updateDecision\(match, "confirmed"\)/);
  assert.match(editorService, /queue_generated_version_previews/);
  assert.match(editorService, /"preview_jobs": preview_jobs/);
  assert.doesNotMatch(app, /processing-notifications/);
  assert.doesNotMatch(app, /Processing interrupted/);
});
