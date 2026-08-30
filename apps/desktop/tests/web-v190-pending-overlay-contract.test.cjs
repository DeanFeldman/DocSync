"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");
const experience = fs.readFileSync(
  path.join(repositoryRoot, "apps/web/src/DocumentExperience.tsx"),
  "utf8",
);

test("pending editor and Find & Replace operations overlay the immutable Word block", () => {
  assert.match(experience, /function pendingEditorOperationForBlock/);
  assert.match(experience, /function pendingDraftForBlock/);
  assert.match(experience, /text: target\?\.replacement_text \?\? block\.text/);
  assert.match(experience, /setDraft\(pendingDraftForBlock\(block, pendingBatch\)\)/);
  assert.match(experience, /fetchDraftEditBatch\(documentSet\.id\)/);
  assert.match(experience, /window\.addEventListener\(BATCH_UPDATED_EVENT, refreshPendingBatch\)/);
  assert.match(experience, /function pendingFindReplacementForBlock/);
  assert.match(experience, /operation\.operation_type === "find_replace"/);
  assert.match(experience, /occurrence\.segment_text === block\.text/);
});

test("staging status preserves user text until a durable pending operation exists", () => {
  assert.match(experience, /setStagingStatus\("editing"\)/);
  assert.match(experience, /setStagingStatus\("saving"\)/);
  assert.match(experience, /setStagingStatus\("saved"\)/);
  assert.match(experience, /Could not add to Pending Changes/);
  assert.match(experience, /✓ Pending/);
  assert.match(experience, /sourceDiffersFromBase/);
  assert.match(experience, /removeEditorEditFromPendingBatch/);
});

test("pending editor operations remain visible over the immutable Layout page", () => {
  const overlay = fs.readFileSync(
    path.join(repositoryRoot, "apps/web/src/WordPreviewOverlay.tsx"),
    "utf8",
  );
  const styles = fs.readFileSync(
    path.join(repositoryRoot, "apps/web/src/styles.css"),
    "utf8",
  );

  assert.match(experience, /pendingLayoutOverridesByElementId/);
  assert.match(experience, /pendingOverridesByElementId=\{pendingLayoutOverridesByElementId\}/);
  assert.match(overlay, /interface PendingLayoutOverride/);
  assert.match(overlay, /const pendingOverlays = useMemo/);
  assert.match(overlay, /render-map-pending-overlay/);
  assert.match(overlay, /Pending change:/);
  assert.match(styles, /\.render-map-pending-overlay[\s\S]*background: rgba\(255, 255, 255, 0\.97\)/);
  assert.match(styles, /\.render-map-pending-overlay[\s\S]*white-space: pre-wrap/);
});
