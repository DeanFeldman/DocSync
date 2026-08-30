"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { accountWorkspacePath } = require("../account-workspace.cjs");
const { copyToStaging, declineMigration, finalizeStaging, migrationStatus, validateStagingLayout } = require("../legacy-workspace-migration.cjs");
const A = "11111111-1111-4111-8111-111111111111";
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "docsync-migration-")); const legacy = path.join(root, "workspace"); fs.mkdirSync(path.join(legacy, "originals"), { recursive: true }); fs.writeFileSync(path.join(legacy, "documentsync.db"), Buffer.from("SQLite format 3\0fixture")); fs.writeFileSync(path.join(legacy, "originals", "keep.txt"), "source"); return { root, legacy, workspace: accountWorkspacePath(root, A) }; }
test("not now keeps legacy and a separate account workspace untouched", () => { const { root, legacy, workspace } = fixture(); fs.mkdirSync(workspace, { recursive: true }); declineMigration(workspace); assert.equal(fs.readFileSync(path.join(legacy, "originals", "keep.txt"), "utf8"), "source"); assert.equal(migrationStatus({ userData: root, workspace, workspaceWasNew: true }).state, "migration_declined"); });
test("copy-first import retains source and atomically activates validated staging", () => { const { root, legacy, workspace } = fixture(); fs.mkdirSync(workspace, { recursive: true }); const { staging, sourceFingerprint } = copyToStaging({ userData: root, workspace }); validateStagingLayout(staging); finalizeStaging({ workspace, staging, sourceFingerprint }); assert.equal(fs.readFileSync(path.join(legacy, "originals", "keep.txt"), "utf8"), "source"); assert.equal(fs.readFileSync(path.join(workspace, "originals", "keep.txt"), "utf8"), "source"); assert.equal(migrationStatus({ userData: root, workspace, workspaceWasNew: false }).state, "migration_complete"); });
test("corrupt source is rejected without changing the source or target", () => { const { root, legacy, workspace } = fixture(); fs.writeFileSync(path.join(legacy, "documentsync.db"), "not sqlite"); fs.mkdirSync(workspace, { recursive: true }); const { staging } = copyToStaging({ userData: root, workspace }); assert.throws(() => validateStagingLayout(staging)); assert.equal(fs.readFileSync(path.join(legacy, "documentsync.db"), "utf8"), "not sqlite"); assert.ok(fs.existsSync(workspace)); });
test("existing account workspaces are migration conflicts and never overwritten", () => { const { root, workspace } = fixture(); fs.mkdirSync(workspace, { recursive: true }); assert.equal(migrationStatus({ userData: root, workspace, workspaceWasNew: false }).state, "migration_conflict"); });
