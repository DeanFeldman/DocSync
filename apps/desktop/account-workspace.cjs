"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function accountWorkspacePath(userData, userId) { if (typeof userData !== "string" || !UUID.test(userId || "")) throw new Error("A canonical account UUID is required."); return path.join(userData, "accounts", userId.toLowerCase(), "workspace"); }
function deviceId(userData) { const target = path.join(userData, "device-id"); try { const value = fs.readFileSync(target, "utf8").trim(); if (UUID.test(value)) return value.toLowerCase(); } catch {} const value = crypto.randomUUID(); fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(target, value, "utf8"); return value; }
function legacyWorkspaceDetected(userData, workspace) { const legacy = path.join(userData, "workspace"); return fs.existsSync(legacy) && !fs.existsSync(workspace); }
module.exports = { accountWorkspacePath, deviceId, legacyWorkspaceDetected };
