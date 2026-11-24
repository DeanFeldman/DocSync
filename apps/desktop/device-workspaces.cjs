"use strict";

const fs = require("node:fs");
const path = require("node:path");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function existingWorkspace(workspace) {
  try {
    return fs.lstatSync(workspace).isDirectory() &&
      fs.lstatSync(path.join(workspace, "documentsync.db")).isFile();
  } catch {
    return false;
  }
}

function workspaceChoices(userData) {
  const choices = [{ id: "device", name: "Device workspace", path: path.join(userData, "workspace") }];
  for (const [directory, prefix, label] of [
    ["accounts", "existing", "Existing local workspace"],
    ["imports", "imported", "Imported workspace"],
  ]) {
    const root = path.join(userData, directory);
    if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const workspace = path.join(root, entry.name, "workspace");
      if (existingWorkspace(workspace)) {
        choices.push({ id: prefix + ":" + entry.name, name: label + " · " + entry.name.slice(0, 8), path: workspace });
      }
    }
  }
  return choices;
}

function selectInitialWorkspace(userData) {
  const choices = workspaceChoices(userData);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "selected-workspace.json"), "utf8"));
    const match = choices.find((choice) => choice.id === saved.id);
    if (match) return match;
  } catch { /* First device-only launch. */ }
  const local = choices.filter((choice) => existingWorkspace(choice.path));
  local.sort((left, right) =>
    fs.statSync(path.join(right.path, "documentsync.db")).mtimeMs -
    fs.statSync(path.join(left.path, "documentsync.db")).mtimeMs,
  );
  return local[0] ?? choices[0];
}

function rememberWorkspace(userData, id) {
  fs.mkdirSync(userData, { recursive: true });
  const target = path.join(userData, "selected-workspace.json");
  const temporary = target + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({ id }), "utf8");
  fs.renameSync(temporary, target);
}

function stageLocation(workspace, importId) {
  if (typeof importId !== "string" || !UUID.test(importId)) {
    throw new Error("Invalid workspace import.");
  }
  return path.join(path.dirname(workspace), "device-restore", importId);
}

function moveImportedWorkspace(userData, workspace, id) {
  const staged = stageLocation(workspace, id);
  if (!existingWorkspace(staged)) throw new Error("The validated workspace is unavailable.");
  const settings = JSON.parse(fs.readFileSync(path.join(staged, "import-settings.json"), "utf8"));
  const root = path.join(userData, "imports", id);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root);
  const target = path.join(root, "workspace");
  fs.renameSync(staged, target);
  return { id: "imported:" + id, path: target, staged, appearance: settings.appearance };
}

module.exports = {
  existingWorkspace, workspaceChoices, selectInitialWorkspace, rememberWorkspace,
  stageLocation, moveImportedWorkspace,
};
