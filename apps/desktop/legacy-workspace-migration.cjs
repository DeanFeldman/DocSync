"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DATABASE_NAME = "documentsync.db";

function accountRoot(workspace) {
  return path.dirname(workspace);
}

function legacyWorkspacePath(userData) {
  return path.join(userData, "workspace");
}

function migrationStatePath(workspace) {
  return path.join(accountRoot(workspace), "legacy-workspace-migration.json");
}

function readMigrationState(workspace) {
  try {
    const value = JSON.parse(fs.readFileSync(migrationStatePath(workspace), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeMigrationState(workspace, state) {
  const target = migrationStatePath(workspace);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
}

function fingerprint(source) {
  const database = path.join(source, DATABASE_NAME);
  const details = fs.statSync(database);
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(database));
  return { database_sha256: hash.digest("hex"), database_bytes: details.size };
}

function migrationStatus({ userData, workspace, workspaceWasNew }) {
  const source = legacyWorkspacePath(userData);
  const state = readMigrationState(workspace);
  const legacyDetected = fs.existsSync(source);
  if (!legacyDetected) return { state: "none", legacy_workspace_detected: false, migration_ready: false };
  if (state.status === "complete") return { state: "migration_complete", legacy_workspace_detected: true, migration_ready: false };
  if (state.status === "declined") return { state: "migration_declined", legacy_workspace_detected: true, migration_ready: false };
  if (!workspaceWasNew) return { state: "migration_conflict", legacy_workspace_detected: true, migration_ready: false, message: "This account already has a local workspace, so DocSync will not replace or merge it." };
  return { state: "migration_ready", legacy_workspace_detected: true, migration_ready: true };
}

function copyToStaging({ userData, workspace }) {
  const source = legacyWorkspacePath(userData);
  const staging = path.join(accountRoot(workspace), `migration-temp-${crypto.randomUUID()}`);
  if (!fs.existsSync(source)) throw new Error("No existing local workspace is available to import.");
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
  return { source, staging, sourceFingerprint: fingerprint(source) };
}

function validateStagingLayout(staging) {
  const database = path.join(staging, DATABASE_NAME);
  if (!fs.statSync(database).isFile()) throw new Error("The existing workspace database is missing.");
  const header = fs.readFileSync(database, { encoding: null, flag: "r" }).subarray(0, 16).toString("ascii");
  if (header !== "SQLite format 3\u0000") throw new Error("The existing workspace database is not a valid SQLite database.");
  for (const directory of ["originals", "generated", "renders"]) {
    const candidate = path.join(staging, directory);
    if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) throw new Error("The copied workspace has an invalid storage directory.");
  }
}

function finalizeStaging({ workspace, staging, sourceFingerprint }) {
  const prior = `${workspace}.pre-import-${crypto.randomUUID()}`;
  if (!fs.existsSync(staging)) throw new Error("The workspace import staging area is unavailable.");
  try {
    if (fs.existsSync(workspace)) fs.renameSync(workspace, prior);
    fs.renameSync(staging, workspace);
    fs.rmSync(prior, { recursive: true, force: true });
    writeMigrationState(workspace, { status: "complete", completed_at: new Date().toISOString(), source: sourceFingerprint });
  } catch (error) {
    if (!fs.existsSync(workspace) && fs.existsSync(prior)) fs.renameSync(prior, workspace);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function declineMigration(workspace) {
  writeMigrationState(workspace, { status: "declined", declined_at: new Date().toISOString() });
}

module.exports = { copyToStaging, declineMigration, finalizeStaging, legacyWorkspacePath, migrationStatus, readMigrationState, validateStagingLayout };
