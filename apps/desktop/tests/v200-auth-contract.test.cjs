"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Google OAuth is limited to the Supabase authorization endpoint and exact callback", () => {
  const main = read("apps/desktop/main.cjs");
  assert.match(main, /url\.protocol === "https:"/);
  assert.match(main, /supabase\\\.co/);
  assert.ok(main.includes('url.pathname === "/auth/v1/authorize"'));
  assert.match(main, /value\.protocol !== "za\.co\.docsync:"/);
  assert.match(main, /value\.hostname !== "auth"/);
  assert.ok(main.includes('value.pathname !== "/callback"'));
  assert.match(main, /auth:open-oauth/);
  assert.match(main, /if \(!trustedOAuthUrl\(url\)\) return false/);
});

test("auth persistence is encrypted, removable, and not exposed as plaintext", () => {
  const main = read("apps/desktop/main.cjs");
  const preload = read("apps/desktop/preload.cjs");
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /safeStorage\.decryptString/);
  assert.match(main, /auth-storage:remove/);
  assert.match(main, /fs\.rmSync\(authStoragePath\(\), \{ force: true \}\)/);
  assert.match(preload, /authStorage: Object\.freeze/);
});

test("account UI exchanges callbacks, presents all basic states, and clears persisted state on sign-out", () => {
  const account = read("apps/web/src/AuthAccount.tsx");
  assert.match(account, /exchangeCodeForSession/);
  assert.match(account, /"signed_out"/);
  assert.match(account, /"signing_in"/);
  assert.match(account, /"signed_in"/);
  assert.match(account, /full_name \|\| user\.email \|\| "Signed in"/);
  assert.match(account, /authStorage\?\.remove\(\)/);
  assert.match(account, /Sign out/);
});
