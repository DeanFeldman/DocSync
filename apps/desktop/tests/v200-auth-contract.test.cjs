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

test("auth gate hides the workspace until session restoration succeeds and clears it on sign-out", () => {
  const main = read("apps/web/src/main.tsx");
  const gate = read("apps/web/src/AuthGate.tsx");
  const account = read("apps/web/src/AuthAccount.tsx");
  assert.match(main, /<AuthGate><App \/><\/AuthGate>/);
  assert.match(gate, /"loading" \| "signed_out" \| "signing_in" \| "signed_in" \| "error"/);
  assert.match(gate, /client\.auth\.getSession/);
  assert.match(gate, /client\.auth\.getUser/);
  assert.match(gate, /getAuthCallback/);
  assert.match(gate, /exchangeCodeForSession/);
  assert.match(gate, /Continue with Google/);
  assert.match(gate, /Your documents remain stored locally/);
  assert.match(gate, /authStorage\?\.remove\(\)/);
  assert.match(gate, /Could not connect to DocSync account services/);
  assert.match(account, /useAuthenticatedUser/);
  assert.match(account, /full_name \|\| user\.email \|\| "Signed in"/);
  assert.match(account, /Sign out/);
});
