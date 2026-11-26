"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `${start} was not found`);
  assert.notEqual(endIndex, -1, `${end} was not found after ${start}`);
  return source.slice(startIndex, endIndex);
}

test("workspace shell is committed before the first document resource", () => {
  const app = read("apps/web/src/App.tsx");
  const openWorkspace = between(
    app,
    "function openWorkspace",
    "async function handleUpload",
  );

  assert.match(openWorkspace, /setDocumentSet\(workspace\)/);
  assert.match(openWorkspace, /setActiveDocumentId\(firstDocument\?\.id/);
  assert.doesNotMatch(openWorkspace, /await\s+fetchDocumentView/);
  assert.match(app, /<CreationProgress stage=\{creationStage\}/);
  assert.match(app, /Validating safe DOCX packages/);
  assert.match(app, /Preparing structured editor data/);
});

test("workspace resources are version keyed, bounded, and request deduplicated", () => {
  const resources = read("apps/web/src/workspaceResources.ts");

  assert.match(resources, /new BoundedLruCache<WorkspaceResource>\(48\)/);
  assert.match(resources, /private readonly inFlight = new Map/);
  assert.match(resources, /const pending = this\.inFlight\.get\(key\)/);
  assert.match(resources, /editorResourceKey[\s\S]*versionId/);
  assert.match(resources, /wordPreviewResourceKey[\s\S]*versionId/);
  assert.match(resources, /nearMatchesResourceKey[\s\S]*versionScope/);
  assert.match(resources, /deleteWhere/);
});

test("Word rendering reuses one serial worker and packaged assets include its script", () => {
  const worker = read("apps/api/app/word_render_service.py");
  const powershell = read("apps/api/scripts/render_docx_worker.ps1");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(worker, /class PersistentWordRenderWorker/);
  assert.match(worker, /self\._lock = threading\.Lock/);
  assert.match(worker, /docsync\.word_worker_startup_timing/);
  assert.match(worker, /reason="render_failure"/);
  assert.match(powershell, /New-Object -ComObject Word\.Application/);
  assert.match(powershell, /while \(\$null -ne \(\$line = \[Console\]::In\.ReadLine\(\)\)\)/);
  assert.match(powershell, /\$document\.Close\(0\)/);
  assert.match(powershell, /\$script:word\.Quit\(\)/);
  assert.ok(
    packageJson.build.extraResources.some(
      (resource) => resource.from === "apps/api/scripts/render_docx_worker.ps1",
    ),
  );
});

test("development startup skips production builds and launches the live stack", () => {
  const packageJson = JSON.parse(read("package.json"));
  const development = read("scripts/dev-desktop.cjs");
  const desktop = read("apps/desktop/main.cjs");

  assert.equal(packageJson.scripts.prestart, undefined);
  assert.equal(packageJson.scripts.start, "node scripts/start-desktop.cjs");
  assert.match(read("scripts/start-desktop.cjs"), /delete electronEnvironment\.ELECTRON_RUN_AS_NODE/);
  assert.equal(packageJson.scripts.dev, "node scripts/dev-desktop.cjs");
  assert.match(development, /desktop_backend\.py/);
  assert.match(development, /node_modules", "vite", "bin", "vite\.js/);
  assert.match(development, /DOCUMENTSYNC_WEB_DEV_URL/);
  assert.match(desktop, /developmentWebUrl \|\| backendOrigin/);
});
