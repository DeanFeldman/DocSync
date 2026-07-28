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

test("Word preview, near matching, and version history are explicit lazy resources", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const wordPreviewHandler = between(
    experience,
    "async function loadWordPreview",
    "function setWorkspaceMode",
  );

  assert.match(wordPreviewHandler, /renderDocumentView\(activeVersionId\)/);
  assert.match(experience, /Load Word Preview/);
  assert.match(experience, /Retry Word Preview/);
  assert.match(experience, /onToggle=\{\(event\) =>/);
  assert.match(experience, /setHistoryRequested\(true\)/);
  assert.match(
    experience,
    /mode === "compare"\s*\?\s*loadWorkspaceResource\(/,
  );
  assert.match(experience, /fetchSimilarMatches\(selectedBlock!/);
  assert.doesNotMatch(experience, /compareDocumentElements/);
});

test("large editor lists render progressively with memoized cards", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");

  assert.match(experience, /const BlockCard = memo/);
  assert.match(experience, /INITIAL_VISIBLE_BLOCKS = 200/);
  assert.match(experience, /\.slice\(0, visibleBlockCount\)/);
  assert.match(experience, /Show next/);
});
