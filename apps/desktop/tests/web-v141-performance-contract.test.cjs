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

test("Word preview auto-loads while near matching and version history remain lazy", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const wordPreviewHandler = between(
    experience,
    "async function loadWordPreview",
    "function setWorkspaceMode",
  );

  assert.match(wordPreviewHandler, /createPreviewJob\(activeVersionId/);
  assert.match(wordPreviewHandler, /fetchPreviewJob\(job\.job_id/);
  assert.match(wordPreviewHandler, /fetchWordPreview\(activeVersionId/);
  assert.match(wordPreviewHandler, /job\.cached_preview/);
  assert.match(wordPreviewHandler, /refreshWorkspaceResource/);
  assert.match(
    experience,
    /previewVersionStartedRef\.current === activeVersionId[\s\S]*void loadWordPreview\(\)/,
  );
  assert.doesNotMatch(experience, /Load Word Preview/);
  assert.match(
    experience,
    /onRetryPreview=\{\(\) => void loadWordPreview\(true\)\}/,
  );
  assert.match(experience, /"Updating preview/);
  assert.match(experience, /"Opening document/);
  assert.match(experience, /showLayoutStructure \|\|[\s\S]*!layoutView/);
  assert.match(experience, /onToggle=\{\(event\) =>/);
  assert.match(experience, /setHistoryRequested\(true\)/);
  assert.match(
    experience,
    /loadNearMatches\s*\?\s*loadWorkspaceResource\(/,
  );
  assert.match(experience, /fetchSimilarMatches\(selectedBlock!/);
  assert.doesNotMatch(experience, /compareDocumentElements/);
  assert.match(
    experience,
    /exactResult\.value\.exact_matches\s*\?\?/,
  );
  assert.match(
    experience,
    /match\.element_type === selectedBlock!\.element_type/,
  );
});

test("Layout fallback renders stable grouped blocks without the removed card list", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(experience, /function LayoutFallbackBlock/);
  assert.match(
    experience,
    /groupStructuredBlocks\(editorContent\.blocks\)\.map/,
  );
  assert.match(experience, /group\.blocks\.map\(\(block\) =>/);
  assert.match(experience, /key=\{block\.element_id\}/);
  assert.doesNotMatch(experience, /const BlockCard = memo/);
  assert.doesNotMatch(experience, /INITIAL_VISIBLE_BLOCKS/);
});

test("generation is accepted immediately and reconciled by the application shell", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const app = read("apps/web/src/App.tsx");
  const api = read("apps/web/src/api.ts");

  assert.match(api, /editor-generate-async/);
  assert.match(api, /generation-jobs\/\$\{operationId\}/);
  assert.match(api, /document-sets\/\$\{documentSetId\}\/generation-jobs/);
  assert.match(experience, /await queueEditorEdit\(/);
  assert.match(experience, /setPendingGenerationId\(queued\.generation_id\)/);
  assert.match(experience, /optimisticTarget\.replacement_text/);
  assert.match(experience, /onGenerationQueued\(queued\)/);
  assert.match(app, /fetchEditorGeneration\(jobId/);
  assert.doesNotMatch(app, /processing-indicator/);
  assert.doesNotMatch(app, /fetchRecoverableEditorGenerationJobs/);
  assert.doesNotMatch(app, /retryEditorGeneration/);
  assert.doesNotMatch(app, /processing-notifications/);
  assert.doesNotMatch(app, /pushProcessingNotification/);
  assert.match(app, /A newer version of this document is available/);
  assert.match(experience, /Update accepted/);
  assert.match(experience, /creating and validating the Word versions in the background/);
});
