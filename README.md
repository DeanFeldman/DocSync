# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

DocSync is a local-first Windows desktop application for safely coordinating edits across related Microsoft Word documents.

Upload a set of `.docx` files, inspect their Word layout, edit supported content in a structured rich-text editor, compare repeated wording across documents, preview every change, and generate new immutable document versions. Original uploads are never overwritten.

---

## Download

Download the latest Windows installer from the [GitHub Releases page](https://github.com/DeanFeldman/DocSync/releases/latest).

A completed release contains:

- `DocSync-Setup-<version>.exe` — version-specific Windows installer
- `DocSync-Setup-latest.exe` — copy of the newest installer
- `SHA256SUMS.txt` — SHA-256 checksums for release verification

For most users, download:

```text
DocSync-Setup-latest.exe
```

> The installer is not commercially code-signed yet, so Windows SmartScreen may display a warning.

---

## Version 1.5.0

DocSync `v1.5.0` expands safe Microsoft Word table editing from whole-cell
blocks to individual paragraphs inside supported top-level cells.

### Expanded table editing

- Extracts each non-empty cell paragraph as a separate `table_paragraph` block.
- Stores table, row, column, in-cell paragraph, document-order, and immutable
  version metadata for exact write-back.
- Preserves other paragraphs, cells, table dimensions, shading, borders,
  images, and unrelated formatting when one paragraph changes.
- Supports inline bold, italic, underline, alignment, and safely represented
  ordered/unordered list indentation inside table paragraphs.
- Keeps merged cells, nested tables, drawings, fields, tracked changes, and
  other unsafe table structures visible but read-only with a plain-language
  reason.
- Includes table paragraphs in exact matching, near matching, comparison,
  global search, per-document values, overrides, previews, generation,
  version history, restoration, Undo, and Redo.
- Regenerates legacy table-cell maps through schema migration 2 only after a
  verified workspace database backup has been created.
- Caches Word structure and style metadata while migrating large historical
  workspaces, avoiding repeated full-document traversal during startup.

See [the v1.5.0 release notes](docs/v1.5.0-release-notes.md), the
[editable-editor design](docs/editable-document-editor.md), and the
[manual Word test checklist](docs/v1.5.0-manual-testing.md).

---

## Version 1.4.2

DocSync `v1.4.2` makes installed Windows startup safe and predictable for
existing local workspaces. Ordered schema migrations run once, a verified
timestamped database backup is created before legacy data is changed, and a
failed migration restores the original active database. Packaged startup now
distinguishes an early service crash from a live preparation timeout and allows
up to 120 seconds for a legacy workspace to become ready.

The header displays the installed version as `v1.4.2` on the home and workspace
screens. That value is injected from the root package during the Vite build.
Windows CI also starts the exact frozen backend that is packaged into the
installer and verifies `/api/health` against a temporary workspace.

See [the v1.4.2 release notes](docs/v1.4.2-release-notes.md) for migration
backup/recovery details and the complete verification scope.

## Version 1.4.1

DocSync `v1.4.1` makes workspace creation and Layout/Edit/Compare switching
progressive and version-aware.

### Improvements

- Shows the workspace shell before the first document content request finishes.
- Displays named stages while creating a document set.
- Reuses one validated, parsed DOCX representation during initial extraction
  and editor preparation.
- Caches editor content, Word previews, exact matches, near matches, history,
  and view state by immutable version.
- Opens Layout from structured data and starts Microsoft Word rendering only
  after **Load Word Preview** is selected.
- Defers near matching until Compare and version history until its control is
  opened.
- Restores per-view selection, draft, and scroll state and progressively mounts
  large editor block lists.
- Accepts reviewed generation immediately, reflects the edit optimistically,
  and completes DOCX version creation through a durable local background job.
- Emits local creation-stage timings without adding external telemetry.

See [the v1.4.1 release notes](docs/v1.4.1-release-notes.md) for the complete
behavior and verification summary.

---

## Version 1.4.0

DocSync `v1.4.0` adds direct structured Layout selection and a persistent
application-wide dark theme.

### Improvements

- Lets users select supported headings, paragraphs, list items, and mapped
  top-level table cells directly from the structured **Layout** view.
- Opens the selected Layout block in **Edit**, loads its Delta into Quill, and
  restores keyboard focus without requiring a page or tab change.
- Uses the same draft confirmation, document-version validation, and error
  recovery path for Layout, search, and Edit selections.
- Clearly labels unsupported Word structures as read-only and explains why they
  cannot be edited.
- Keeps the high-fidelity Word/PDF preview read-only when reliable
  page-coordinate metadata is unavailable, with an explicit switch to the
  selectable structured document.
- Adds a keyboard-accessible light/dark theme control in the application header.
- Persists an explicit theme in local storage and otherwise follows the Windows
  system preference without a light-theme startup flash.
- Keeps the active document, mode, block, draft, comparison, preview, scroll
  position, and Quill instance intact when the theme changes.
- Retains the v1.3 editor recovery, dismissible errors, Undo/Redo, global search,
  immutable versioning, and version restoration improvements.

See [the v1.4.0 release notes](docs/v1.4.0-release-notes.md) for the complete
behavior and verification summary.

---

## Main features

### Document sets

- Upload between 2 and 20 related `.docx` files.
- Reopen saved document sets from the local workspace library.
- Add documents to an existing set.
- Remove individual documents.
- Delete a complete document set.
- Search all current document versions from one search field.
- Navigate directly to a matching document block.
- View the number of files, elements, and exact-match groups.
- Switch between light and dark mode without losing the current workspace state.

### Layout, Edit, and Compare

DocSync provides three document workspace modes.

#### Layout

- Displays the selectable structured document immediately.
- Generates a read-only Microsoft Word preview only after the explicit
  **Load Word Preview** action.
- Reuses the Word preview for the same immutable document version.
- Opens supported structured Layout blocks directly in the editor.
- Shows unsupported or preserved Word structures as read-only with a reason.
- Uses the selectable structured view as the safe fallback when reliable
  rendered-page coordinates are unavailable.
- Preserves the original document as the authoritative layout reference.

#### Edit

- Exposes supported headings, paragraphs, list items, and individual
  paragraphs in supported top-level table cells as stable blocks.
- Uses Quill 2 for structured rich-text editing.
- Supports selected formatting metadata, including:
  - bold
  - italic
  - underline
  - heading levels
  - ordered and unordered lists
  - indentation
  - alignment
- Keeps one mapped Word block active at a time.
- Provides visible Undo and Redo controls.
- Prevents multiline paste, splitting, merging, and reordering where these operations could break document mapping.

#### Compare

- Finds exact wording matches across documents.
- Finds bounded near-match candidates.
- Shows similarity scores.
- Displays word-level differences.
- Requires explicit confirmation before near matches can be edited.
- Lets the user include or exclude eligible targets.

### Editing modes

DocSync supports three controlled editing modes:

1. **Shared wording**  
   Apply the active draft to selected exact matches. Near matches remain protected unless explicitly confirmed.

2. **Per-document values**  
   Provide a different replacement value for each selected document target.

3. **Whole-paragraph override**  
   Change only the selected source block and detach it from shared updates.

### Preview and generation

- Preview the resolved result before writing any files.
- Show every affected document, source version, editing mode, and exact table
  paragraph location.
- Reject stale operations when a document changed after the editor was opened.
- Generate changes atomically.
- Create new immutable document versions.
- Keep original uploads unchanged.
- Continue editing from the newly generated current versions.

### Downloads and version history

- Download the current document.
- Download any recorded document version.
- Download the complete document set as a ZIP archive.
- Download generated operation output.
- Inspect document version lineage.
- Restore an earlier version by copying it into a new current version.
- Keep the restored source version and all later history available.

---

## Safety model

DocSync is designed around controlled document editing.

- Original uploaded files are never overwritten.
- Every supported editor block is mapped to a stored Word element.
- Preview operations do not write new files or database records.
- Confirmed edits create new versions rather than replacing history.
- Generation requests use the same source versions that were previewed.
- Stale edits are rejected when a document changes before generation.
- Failed generation operations are rolled back.
- Unsupported Word structures are preserved and shown as read-only.
- Local error messages can be dismissed without disabling the editor.

---

## How it works

1. Create a document set.
2. Upload related Microsoft Word documents.
3. Open a document in **Layout** or **Edit**.
4. In **Layout**, choose **Select from document structure** when a Word-rendered
   preview is shown.
5. Select one supported block; DocSync opens and focuses it in **Edit**.
6. Edit the block in the structured editor.
7. Review exact and near matches in **Compare**.
8. Choose the editing mode.
9. Select the intended targets.
10. Preview the complete result.
11. Generate new immutable versions.
12. Download or restore versions when needed.

---

## Technology

- **Desktop shell:** Electron
- **Installer:** Electron Builder and NSIS
- **Frontend:** React, TypeScript, Vite, and Quill 2
- **Backend:** FastAPI and Python
- **Document processing:** `python-docx`
- **Database:** SQLAlchemy with SQLite
- **Backend packaging:** PyInstaller
- **Automation:** GitHub Actions

The packaged Windows application includes the Electron runtime and the frozen Python backend. Installed users do not need Node.js, npm, Python, or developer tools.

---

## Requirements

### Installed application

- Windows 10 or Windows 11
- Microsoft Word desktop is recommended for high-fidelity layout preview

Microsoft Word is not required for the structured fallback preview.

### Development

- Windows 10 or Windows 11
- Node.js 22 or newer
- Python 3.11 or newer
- npm
- Microsoft Word desktop for high-fidelity layout rendering

---

## Configuration and local data

The backend reads configuration from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCUMENTSYNC_DATA_DIR` | `./data` | SQLite database, uploads, generated files, and render cache |
| `DOCUMENTSYNC_DATABASE_URL` | SQLite inside the data directory | Database connection |
| `DOCUMENTSYNC_MAX_FILE_BYTES` | `10485760` | Maximum upload size per file |
| `DOCUMENTSYNC_MAX_FILES_PER_SET` | `20` | Maximum documents in a set |
| `DOCUMENTSYNC_NEAR_MATCH_THRESHOLD` | `0.82` | Minimum near-match similarity score |
| `DOCUMENTSYNC_NEAR_MATCH_CANDIDATE_LIMIT` | `25` | Maximum near-match candidates inspected |
| `DOCUMENTSYNC_CORS_ORIGINS` | Local Vite origins | Allowed browser-development origins |

See [`.env.example`](.env.example) for a local development template.

Existing workspaces are upgraded by ordered, one-time schema migrations when the
backend starts. Before an older database is modified, DocSync stores and verifies
a timestamped backup under `workspace/migration-backups`; the five newest
backups are retained. A current workspace skips completed migrations and does
not rerun the version/block-revision or table-paragraph backfill. Schema 2
reparses stored immutable DOCX versions to replace legacy whole-cell maps with
paragraph-level table locations. No manual migration command is normally
required.

If migration fails, the active database is restored automatically and the
startup dialog shows the workspace and recovery-backup paths. Do not move or
delete the workspace. Close DocSync before any manual restore, preserve the
active `documentsync.db`, then copy the support-selected backup into place as
`documentsync.db`. See the
[v1.4.2 recovery notes](docs/v1.4.2-release-notes.md#manual-recovery).

---

## Run locally

Run these commands from the repository root in Windows PowerShell:

```powershell
cd "C:\path\to\DocSync"

npm.cmd install
python -m pip install -r apps/api/requirements.txt

npm.cmd test
npm.cmd start
```

`npm.cmd start` builds the React frontend, starts the local FastAPI service, and opens DocSync in an Electron window.

### PowerShell execution-policy error

When PowerShell blocks `npm.ps1`, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Alternatively, allow scripts only for the current PowerShell session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## Run the frontend and backend separately

### Backend

```powershell
cd apps/api

python -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8001
```

FastAPI documentation is available at:

```text
http://localhost:8001/docs
```

### Frontend

Open another terminal:

```powershell
cd apps/web

npm.cmd install
npm.cmd run dev
```

Then open:

```text
http://localhost:5173
```

---

## Testing

Run all tests from the repository root:

```powershell
npm.cmd test
```

Run backend tests directly:

```powershell
python -m pip install -r apps/api/requirements.txt
python -m pytest apps/api
```

Build-check the frontend:

```powershell
npm.cmd run build:web
```

---

## Build the Windows installer

Install build requirements:

```powershell
python -m pip install -r apps/api/requirements-build.txt
npm.cmd install
```

Build the installer:

```powershell
npm.cmd run dist:win
```

The installer is written to:

```text
release/v1/DocSync-Setup-<version>.exe
```

The unpacked application may also appear under:

```text
release/v1/win-unpacked/
```

Do not commit the `release/` directory. Installer files belong on the GitHub Releases page.

---

## Release process

The release workflow runs whenever a tag beginning with `v` is pushed.

The workflow reads the application version from the Git tag, so the source `package.json` version does not need to be changed manually for each release.

### Create a release

From the repository root:

```powershell
$version = "1.5.0"

git switch main
git pull origin main
git status

npm.cmd ci
python -m pip install -r apps/api/requirements-build.txt
npm.cmd test

git tag -a "v$version" -m "DocSync v$version"
git push origin "v$version"
```

After pushing the tag, open the repository **Actions** tab and follow the **DocSync release** workflow.

The workflow will:

1. Check out the tagged source.
2. Install Node.js and Python dependencies.
3. Set the package version from the Git tag.
4. Run automated tests.
5. Build the Windows installer.
6. Create `DocSync-Setup-latest.exe`.
7. Generate `SHA256SUMS.txt`.
8. Create the GitHub Release.
9. Upload the installer and checksum files.

Before announcing the release, confirm that it contains:

```text
DocSync-Setup-<version>.exe
DocSync-Setup-latest.exe
SHA256SUMS.txt
```

Use semantic version tags:

```text
v1.0.0  Initial stable release
v1.1.0  Backwards-compatible feature release
v1.1.1  Backwards-compatible fix release
v2.0.0  Breaking release
```

Do not reuse or move a published release tag.

---

## Project structure

```text
DocSync/
├── .github/
│   └── workflows/
│       ├── phase3-desktop.yml
│       └── release.yml
├── apps/
│   ├── api/
│   ├── desktop/
│   ├── web/
│   ├── desktop-ui/
│   └── template-api/
├── build/
│   ├── icon.ico
│   └── icon.png
├── docs/
│   ├── adr/
│   └── editable-document-editor.md
├── package.json
├── package-lock.json
└── README.md
```

---

## Core API areas

The local backend provides endpoints for:

- health checks
- document-set management
- document upload and deletion
- document rendering
- structured editor content
- exact and near matching
- comparison decisions
- preview operations
- version generation
- downloads
- version history
- version restoration
- global search

Open the local FastAPI documentation during development for the complete current endpoint list:

```text
http://localhost:8001/docs
```

---

## Known limitations

- The packaged desktop release currently targets Windows.
- High-fidelity layout rendering works best when Microsoft Word desktop is installed.
- High-fidelity Word rendering is intentionally on demand; the structured
  Layout view remains available when Word is missing or a preview fails.
- Some Word structures remain read-only.
- Direct selection is available in the structured Layout view. The
  high-fidelity Word/PDF preview remains read-only until the renderer can
  provide reliable page-relative element coordinates.
- Authentication, PostgreSQL, hosted cloud storage, and multi-device synchronisation are not yet part of the local desktop release.
- The Windows installer is not yet commercially code-signed.

---

## Roadmap

Planned work includes:

- Reliable element-coordinate overlays for the high-fidelity Word/PDF preview
- Broader editing support for complex Word structures
- Stronger file validation and local document protection
- Linux and macOS support
- Hosted authentication
- PostgreSQL support for hosted deployments
- Secure cloud storage and synchronisation
- Automatic desktop update channels
- Ability to summarise changes on each doc (AI)
---

## Contributing

1. Create a branch from `main`.
2. Make one focused change.
3. Run the full test suite.
4. Build-check the frontend.
5. Open a pull request.
6. Do not commit generated installers, local databases, uploads, or secrets.

Example:

```powershell
git switch main
git pull origin main
git switch -c fix/example-change

npm.cmd test
npm.cmd run build:web

git add .
git commit -m "fix: describe the change"
git push -u origin fix/example-change
```

---

## Security

Do not commit:

- API keys
- passwords
- tokens
- private certificates
- production environment files
- user documents
- local databases
- generated release installers

Use environment variables and `.env.example` for local configuration templates.

Report suspected exposed credentials immediately and rotate any real secret that entered Git history.

---

## License

This repository is currently marked as `UNLICENSED`.

Copyright © Dean Feldman.
