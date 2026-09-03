# Bug: Word preview page PNGs fail while selectable areas render

## Observed on current `main`

The Word preview can finish its render-map work and display selectable-area
overlays, but the underlying page image is missing. The browser renders the
image fallback text, for example: `Page 2 of the Word preview`.

This leaves a white page with correctly positioned turquoise selectable areas
and no visible document text.

## Scope

Investigate the page-image delivery path only:

1. `GET /api/document-versions/{version_id}/render-pages/{render_id}/{page}.png`
2. the API response status, content type, and generated file path
3. the `image_url` returned by the render map
4. the browser request and image load failure
5. stale render-map/PDF cache identity after a preview retry or account-workspace switch

Do not change DOCX-to-PDF rendering, immutable-version handling, or the
selectable-area matching behavior while diagnosing this regression.

## Reproduction

1. Start DocSync from current `main`.
2. Open a DOCX preview with selectable areas enabled.
3. Wait until turquoise selectable-area overlays appear.
4. Observe that the page background is white and the image fallback text is
   shown instead of the rendered Word/PDF page.

## Acceptance criteria

- The first visible PDF page loads as an actual PNG before or alongside
  selectable-area overlays.
- Later pages continue to load lazily.
- The image URL returns a successful PNG response for the render-map's active
  `render_id`.
- Selectable areas remain available after the page image is shown.
- Add a regression test covering the returned page-image endpoint or the
  frontend image URL contract.
- Log image request, generated path, response status, and frontend image load
  failures while fixing the issue.

## Evidence

Screenshot captured 2026-09-03: Page 2 displayed the fallback text
`Page 2 of the Word preview` with selectable overlays present. This confirms
that the render map completed but the browser image load failed.

---

# v1.18 non-preview reimplementation inventory

If the codebase must roll back to `v1.17.0` and reimplement v1.18 safely,
retain the following work. None of these changes should be coupled to the
preview-PNG regression above.

## Commit order

Apply and verify the v1.18 work in this order:

1. `2752897` account-scoped local workspace activation
2. `88b5824` encrypted-session account activation binding
3. `99c6cdb` legacy workspace migration and roles
4. `237dee7` local workspace snapshot engine
5. `7d8836d` cloud snapshot foundation
6. `6eaf1df` cloud backup workflow
7. `531ad60` cloud workspace discovery and restore
8. `30001c9` cloud reliability states
9. `0a7af2b` account administration and OAuth completion UI
10. `c6ca2e6` v1.18 release hardening
11. `f4ce875` cloud-backup hardening

The later `e5a0857`, `89bc8d7`, `6510e18`, and `0f89d0f` commits update
download analytics only.

## Features to retain

### Account-scoped workspaces and migrations

- Isolate each signed-in account's local workspace and persist the active
  account/workspace binding.
- Bind account activation to Electron encrypted storage.
- Migrate existing legacy workspaces into an account workspace with validation,
  staging, acceptance/decline flow, and role contracts.
- Keep startup supervision compatible with account workspace activation.

Primary files:

- `apps/desktop/account-workspace.cjs`
- `apps/desktop/legacy-workspace-migration.cjs`
- `apps/desktop/main.cjs`
- `apps/desktop/preload.cjs`
- `apps/desktop/tests/v180-account-workspace.test.cjs`
- `apps/desktop/tests/v181-legacy-migration.test.cjs`
- `apps/desktop/tests/v182-roles-contract.test.cjs`
- `apps/desktop/tests/v142-startup-reliability.test.cjs`

### Snapshots, backup, and restore

- Create bounded, checksummed local cloud-snapshot archives.
- Download snapshot archives and stage verified restore archives.
- Keep backup/restore failure states explicit and preserve account/workspace
  safety checks.

Primary files:

- `apps/api/app/snapshot_service.py`
- `apps/api/app/main.py` (cloud snapshot endpoints only)
- `apps/api/app/config.py`
- `apps/api/tests/test_snapshot_service.py`
- `apps/desktop/tests/v184-cloud-snapshots-contract.test.cjs`
- `apps/desktop/tests/v185-cloud-backup-contract.test.cjs`
- `apps/desktop/tests/v186-cloud-restore-contract.test.cjs`
- `apps/web/src/CloudBackup.tsx`
- `apps/web/src/cloudSnapshots.ts`

### Authentication and account experience

- Google account connection and account administration UI.
- Desktop OAuth callback handling, account-session storage, and reliable
  sign-in/out states.
- The server-side OAuth completion function, including the deep-link return to
  the desktop app.

Primary files:

- `apps/web/src/App.tsx`
- `apps/web/src/AuthAccount.tsx`
- `apps/web/src/AuthGate.tsx`
- `apps/web/src/auth.ts`
- `apps/web/src/api.ts`
- `apps/web/src/electron-auth.d.ts`
- `apps/web/src/styles.css`
- `apps/desktop/tests/v188-account-oauth-contract.test.cjs`
- `apps/desktop/tests/v200-auth-contract.test.cjs`
- `supabase/functions/docsync-auth-complete/index.ts`

### API, configuration, audit, packaging, and deployment support

- Account-aware API configuration and snapshot-size settings.
- Audit-log coverage for the account/cloud workflows.
- Updated desktop dependencies and v1.18 version metadata.
- Supabase cloud schema/checklist and explicit manual release checks.

Primary files:

- `apps/api/app/audit_logger.py`
- `apps/api/app/config.py`
- `apps/api/pyproject.toml`
- `package.json`, `package-lock.json`
- `apps/web/package.json`, `apps/web/package-lock.json`
- `analytics/supabase-v1.18-cloud-schema.sql`
- `analytics/supabase-v1.18-schema.sql`
- `docs/architecture.md`
- `docs/v1.18-cloud-foundation.md`
- `docs/v1.18-oauth-completion.md`
- `docs/v1.18-snapshots.md`
- `docs/v1.18.0-manual-testing.md`
- `docs/v1.18.0-release-notes.md`
- `docs/v1.18.0-supabase-checklist.md`

## Do not treat as product source

- `supabase/.temp/cli-latest` and `supabase/.temp/linked-project.json` are
  Supabase CLI local-link metadata, not source features to reimplement.
- `analytics/README.md`, `analytics/download-history.csv`, and
  `analytics/summary.json` are release/download reporting artifacts. Keep them
  only if the reporting history is wanted.

## Reimplementation verification

After each feature group, run its focused desktop/API tests. Before release,
run the complete Node and API suites, build the web app, build and smoke-test
the Windows API, and verify the packaged desktop flow. Keep a separate visual
test for first-page PNG display and selectable overlays; cloud/account tests
must not be used as evidence that document preview works.
