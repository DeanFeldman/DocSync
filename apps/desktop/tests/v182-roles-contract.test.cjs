"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
test("Supabase roles default to user with self-only read RLS and no self-promotion", () => { const sql = read("analytics/supabase-v1.18-schema.sql"); assert.match(sql, /create table if not exists public\.user_roles/); assert.match(sql, /role text not null check \(role in \('user', 'admin'\)\)/); assert.match(sql, /enable row level security/); assert.match(sql, /grant select on public\.user_roles to authenticated/); assert.match(sql, /revoke insert, update, delete on public\.user_roles from authenticated/); assert.match(sql, /using \(auth\.uid\(\) = user_id\)/); assert.match(sql, /insert into public\.user_roles\(user_id,role\) values\(new\.id,'user'\)/); });
test("role lookup falls back to user and admin UI is role-gated", () => { const gate = read("apps/web/src/AuthGate.tsx"); const account = read("apps/web/src/AuthAccount.tsx"); assert.match(gate, /data\?\.role === "admin" \? "admin" : "user"/); assert.match(gate, /from\("user_roles"\)/); assert.match(account, /role === "admin"/); assert.match(account, />Admin</); });
