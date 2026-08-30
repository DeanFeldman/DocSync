"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Google OAuth is limited to the Supabase authorization endpoint and exact callback", () => {
  const main = read("apps/desktop/main.cjs");
  const packageJson = read("package.json");
  assert.match(main, /url\.protocol === "https:"/);
  assert.match(main, /supabase\\\.co/);
  assert.ok(main.includes('url.pathname === "/auth/v1/authorize"'));
  assert.match(main, /value\.protocol !== "za\.co\.docsync:"/);
  assert.match(main, /value\.hostname !== "auth"/);
  assert.ok(main.includes('value.pathname !== "/callback"'));
  assert.match(main, /auth:open-oauth/);
  assert.match(main, /if \(!trustedOAuthUrl\(url\)\) return false/);
  assert.match(main, /function registerProtocolClient\(\)/);
  assert.match(main, /if \(process\.defaultApp\)/);
  assert.match(main, /process\.execPath, \[path\.resolve\(process\.argv\[1\]\)\]/);
  assert.match(main, /return app\.setAsDefaultProtocolClient\("za\.co\.docsync"\)/);
  assert.match(main, /registerProtocolClient\(\);/);
  assert.match(main, /DOCUMENTSYNC_SUPABASE_URL: publicSupabaseUrl/);
  assert.match(packageJson, /"protocols"/);
  assert.match(packageJson, /"schemes": \["za\.co\.docsync"\]/);
});

test("desktop CSP allows only the configured Supabase origin and serves the built theme bootstrap", () => {
  const api = read("apps/api/app/main.py");
  const config = read("apps/api/app/config.py");
  assert.match(config, /DOCUMENTSYNC_SUPABASE_URL/);
  assert.match(api, /connect-src 'self'/);
  assert.match(api, /settings\.supabase_origin/);
  assert.doesNotMatch(api, /connect-src \*/);
  assert.match(api, /@app\.get\("\/theme-bootstrap\.js"/);
  assert.match(api, /media_type="application\/javascript"/);
});

test("auth persistence is encrypted key/value storage and does not overwrite PKCE or session entries", () => {
  const main = read("apps/desktop/main.cjs");
  const preload = read("apps/desktop/preload.cjs");
  const auth = read("apps/web/src/auth.ts");
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /safeStorage\.decryptString/);
  assert.match(main, /JSON\.parse\(safeStorage\.decryptString/);
  assert.match(main, /JSON\.stringify\(entries\)/);
  assert.match(main, /function getAuthStorageEntry\(key\)/);
  assert.match(main, /function setAuthStorageEntry\(key, value\)/);
  assert.match(main, /function removeAuthStorageEntry\(key\)/);
  assert.match(main, /function clearAuthStorage\(\)/);
  assert.match(main, /auth-storage:remove/);
  assert.match(main, /fs\.rmSync\(authStoragePath\(\), \{ force: true \}\)/);
  assert.match(preload, /authStorage: Object\.freeze/);
  assert.match(preload, /get: \(key\)/);
  assert.match(preload, /set: \(key, value\)/);
  assert.match(preload, /clear: \(\)/);
  assert.match(auth, /getItem: \(storageKey: string\).*bridge\.get\(storageKey\)/);
  assert.match(auth, /setItem: \(storageKey: string, value: string\).*bridge\.set\(storageKey, value\)/);
  assert.match(auth, /removeItem: \(storageKey: string\).*bridge\.remove\(storageKey\)/);
});

test("auth gate hides the workspace until session restoration succeeds and clears it on sign-out", () => {
  const main = read("apps/web/src/main.tsx");
  const app = read("apps/web/src/App.tsx");
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
  assert.match(gate, /console\.error\("DocSync OAuth code exchange failed:", exchangeError\)/);
  assert.match(gate, /authStorage\?\.clear\(\)/);
  assert.match(gate, /Could not connect to DocSync account services/);
  assert.match(account, /useAuthenticatedUser/);
  assert.match(account, /full_name \|\| user\.email \|\| "Signed in"/);
  assert.match(account, /Sign out/);
  assert.ok(app.indexOf("<AuthAccount />") < app.indexOf("{!documentSet ? ("));
  assert.equal((app.match(/<AuthAccount \/>/g) || []).length, 1);
});
