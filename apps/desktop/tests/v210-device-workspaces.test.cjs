"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const {
  workspaceChoices, selectInitialWorkspace, rememberWorkspace,
  stageLocation, moveImportedWorkspace,
} = require("../device-workspaces.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docsync-device-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function workspaceAt(root, relative) {
  const folder = path.join(root, relative);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "documentsync.db"), relative);
  return folder;
}

test("first launch opens a local workspace and preserves old account folders without login", (t) => {
  const root = fixture(t);
  const id = randomUUID();
  assert.equal(selectInitialWorkspace(root).id, "device");
  const existing = workspaceAt(root, path.join("accounts", id, "workspace"));
  assert.equal(selectInitialWorkspace(root).path, existing);
  assert.ok(workspaceChoices(root).some((item) => item.id === "existing:" + id));
  rememberWorkspace(root, "device");
  assert.equal(selectInitialWorkspace(root).id, "device");
  assert.ok(fs.existsSync(path.join(existing, "documentsync.db")));
});

test("confirmed import opens a distinct local workspace and leaves the source workspace intact", (t) => {
  const root = fixture(t);
  const active = workspaceAt(root, "workspace");
  const id = randomUUID();
  const staged = stageLocation(active, id);
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "documentsync.db"), "imported data");
  fs.writeFileSync(path.join(staged, "import-settings.json"), '{"appearance":"dark"}');
  assert.equal(workspaceChoices(root).length, 1);
  const imported = moveImportedWorkspace(root, active, id);
  assert.equal(imported.appearance, "dark");
  assert.equal(fs.readFileSync(path.join(active, "documentsync.db"), "utf8"), "workspace");
  assert.equal(fs.readFileSync(path.join(imported.path, "documentsync.db"), "utf8"), "imported data");
  rememberWorkspace(root, imported.id);
  assert.equal(selectInitialWorkspace(root).id, imported.id);
  assert.throws(() => stageLocation(active, "../outside"));
  assert.throws(() => moveImportedWorkspace(root, active, id));
});
