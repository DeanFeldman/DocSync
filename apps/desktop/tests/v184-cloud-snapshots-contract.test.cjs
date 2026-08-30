"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
test("cloud provider uses authenticated UUID ownership and never a secret", () => { const provider = read("apps/web/src/cloudSnapshots.ts"); assert.match(provider, /auth\.getUser\(\)/); assert.match(provider, /users\/\$\{validUuid\(data\.user\.id\)\}\/snapshots\/\$\{validUuid\(snapshotId\)\}\.zip/); assert.doesNotMatch(provider, /SUPABASE_SECRET_KEY|service_role/); assert.match(provider, /WorkspaceSnapshotStorageProvider/); assert.match(provider, /uploadSnapshot.*downloadSnapshot.*deleteSnapshot.*exists.*metadata/s); });
test("cloud SQL uses private storage, own-row RLS, and atomic auth.uid promotion", () => { const sql = read("analytics/supabase-v1.18-cloud-schema.sql"); assert.match(sql, /docsync-workspaces', 'docsync-workspaces', false/); assert.match(sql, /alter table public\.devices enable row level security/); assert.match(sql, /alter table public\.workspace_snapshots enable row level security/); assert.match(sql, /alter table public\.workspace_heads enable row level security/); assert.match(sql, /user_id = auth\.uid\(\)/); assert.match(sql, /split_part\(name,'\/',2\) = auth\.uid\(\)::text/); assert.match(sql, /security definer set search_path = public/); assert.match(sql, /v_user uuid := auth\.uid\(\)/); assert.match(sql, /for update/); assert.match(sql, /'status','conflict'/); assert.match(sql, /revoke all on function/); assert.doesNotMatch(sql, /grant .*workspace_heads.*update.*authenticated/i); });
