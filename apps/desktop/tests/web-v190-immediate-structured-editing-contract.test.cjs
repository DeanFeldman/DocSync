"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("the workspace opens directly in Layout, with a text editor when geometry is unavailable", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  assert.match(experience, /id="workspace-panel-layout"/);
  assert.doesNotMatch(experience, /workspace-panel-edit|workspace-mode-tabs/);
  assert.match(experience, /preloadInlineLayoutEditor\(\)/);
  assert.match(experience, /!inlineSelection && draft && \([\s\S]*?<InlineLayoutEditor/);
  assert.match(experience, /previewVersionStartedRef\.current = activeVersionId[\s\S]*void loadWordPreview\(\)/);
});

test("both Layout editing paths preserve drafts across selections", () => {
  const experience = read("apps/web/src/DocumentExperience.tsx");
  const resources = read("apps/web/src/workspaceResources.ts");
  assert.match(resources, /getWorkspaceDraft/);
  assert.match(resources, /setWorkspaceDraft/);
  assert.match(resources, /clearWorkspaceDraft/);
  assert.match(experience, /setWorkspaceDraft\(activeViewStateKey, selectedElementId, nextDraft\)/);
  assert.match(experience, /onChange=\{handleDraftChange\}/);
  assert.match(experience, /onDraftChange=\{handleDraftChange\}/);
});
