# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

DocSync is a local-first Windows desktop application for safely coordinating edits across related Microsoft Word documents.

Upload a set of `.docx` files, inspect their Word layout, edit supported content in a structured rich-text editor, compare repeated wording across documents, preview every change, and generate new immutable document versions. Original uploads are never overwritten.

Opening a document is progressive: DocSync shows cached or structured content first,
then completes the high-fidelity Word preview in the background. An open workspace
fills the desktop window, the application page stays fixed, and scrolling is kept
inside the document list, preview, and editing sidebar.

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

## Version 1.8.0

DocSync `v1.8.0` turns the high-fidelity Word layout into a controlled inline
editing workspace. Selecting a document first checks version-keyed memory and
SQLite preview caches, displays readable structured content as soon as it is
available, and starts the durable Word-preview job automatically. Microsoft Word
rendering is serialized for COM safety, immutable-version PDF caches are reused,
controlled page images appear before coordinate matching finishes, and visible or
nearby pages are mounted first.

Reliable page-relative regions can be focused or clicked without leaving
**Layout**. A restricted Quill editor appears over the selected paragraph and
places its caret near the activation point. Its draft, formatting, Undo/Redo,
exact and near matches, edit mode, targets, preview, and background generation
all use the existing operation state in the right sidebar. The loaded PDF is a
fixed snapshot; Microsoft Word recalculates final wrapping and pagination after
generation, then DocSync queues a fresh preview and render map for the new
immutable version.

Ambiguous mappings are deliberately not interactive. Fields, drawings, images,
text boxes, watermarks, and other unsafe structures remain preserved and
read-only. **Select from structure** and the structured **Edit** view remain the
safe fallback and advanced diagnostic surface.

The open workspace now fills the remaining window height and prevents the outer
application page from scrolling. Long content scrolls only inside the file rail,
Word preview, or operation sidebar. The global **Processing** button, processing
history popover, retry control, and floating interrupted/error notifications have
been removed. Durable generation and reconciliation still run in the background;
relevant progress or action errors stay inline with the active document.

Performance work for the current build reduced the median three-document generation
benchmark by 33.1%. A cached 1,000-block structured preview returned in a 26.98 ms
median, and Quill now loads as a separate lazy chunk only after an editable region
is selected.

See [the v1.8.0 release notes](docs/v1.8.0-release-notes.md),
[inline-layout requirements](docs/v1.8.0-inline-layout-editing-requirements.md),
[manual test plan](docs/v1.8.0-manual-testing.md), and the
[document performance report](docs/performance-optimisation-2026-08.md).

---

## Version 1.7.0

DocSync `v1.7.0` adds safe, section-aware editing for Microsoft Word header
and footer paragraphs. Default, first-page, and even-page parts are extracted
across every section. Linked sections that share one physical Word part are
deduplicated into one editor target and are explained before processing.

Supported header and footer paragraphs use the same single-paragraph rich-text
editor, exact/near comparison, global search, preview, background generation,
immutable history, and restoration flow as body and table paragraphs. Page
numbers, complex fields, logos, images, shapes, watermarks, content controls,
and other unsafe objects remain visible, preserved, and read-only.

Existing workspaces are upgraded by schema migration 4, which reparses every
stored immutable DOCX version after creating and verifying a SQLite backup.
See [the v1.7.0 release notes](docs/v1.7.0-release-notes.md),
[header/footer requirements](docs/v1.7.0-header-footer-requirements.md), and
[manual test plan](docs/v1.7.0-manual-testing.md).

## Version 1.6.0

DocSync `v1.6.0` moves reviewed document processing into durable, non-blocking
background jobs. Process returns quickly while users continue navigating, and
the application records queued, preparing, applying, validating, saving,
refreshing, completed, failed, and interrupted states for safe reconciliation.
Completion selectively refreshes affected document heads, versions, blocks,
matches, search results, and downloads without replacing an unrelated active
draft. The current interface keeps this reconciliation internal rather than
showing a global processing history control.

The release also preserves custom Word list styles when the list type is not
changed, strengthens SQLite processing reliability and conflict handling, and
marks unfinished jobs as interrupted after a restart so they can be retried
safely. See [the v1.6.0 release notes](docs/v1.6.0-release-notes.md).

## Version 1.5.0

DocSync `v1.5.0` maps each non-empty paragraph in a supported top-level table
cell as its own `table_paragraph` block. The immutable location records table,
row, column, paragraph, and document order so selection, formatting, exact and
near matching, preview, and generation all resolve the same Word paragraph.

Schema migration 2 reparses every stored immutable DOCX to backfill
paragraph-level table locations from OOXML. Merged cells, nested tables,
drawings, fields, and other unsafe table structures remain preserved and
read-only. See [the v1.5.0 release notes](docs/v1.5.0-release-notes.md) and
[the editable editor design](docs/editable-document-editor.md).

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

- Displays cached or selectable structured content immediately.
- Starts Microsoft Word rendering automatically and keeps the workspace
  responsive while preview stages progress.
- Reuses the Word preview for the same immutable document version.
- Displays controlled PDF page images before selectable coordinates finish.
- Fills the remaining desktop window height and keeps document scrolling inside
  the preview instead of scrolling the application page.
- Lets users click supported text, place a cursor, and edit the paragraph
  directly without leaving Layout.
- Reuses the complete operation sidebar for formatting, exact and near matches,
  target selection, preview, and generation.
- Shows unsupported or preserved Word structures as read-only with a reason.
- Provides **Select from structure** when a coordinate is missing or uncertain.
- Preserves the original document as the authoritative layout reference.

#### Edit

- Exposes supported headings, body paragraphs, list items, table paragraphs,
  header paragraphs, and footer paragraphs as stable blocks.
- Labels header/footer blocks by section, part type, and paragraph and explains
  when linked sections share the same physical Word part.
- Uses Quill 2 for structured rich-text editing.
- Remains available as a safe fallback and advanced mapping diagnostic view.
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
- Show every affected document and exact body, table, header, or footer
  location, including linked sections.
- Reject stale operations when a document changed after the editor was opened.
- Generate changes atomically.
- Submit processing to a durable background job and keep navigation available.
- Keep background-job reconciliation internal without a global processing button,
  history popover, retry control, or floating processing notifications.
- Show relevant progress and actionable errors inline with the active document.
- Refresh only affected workspace resources when processing completes.
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
- Actionable errors stay inline with the relevant workspace and can be dismissed
  without disabling the editor; processing errors are not shown as floating popups.

---

## How it works

1. Create a document set.
2. Upload related Microsoft Word documents.
3. Open a document in **Layout**. Cached or structured content appears first and
   the Word preview starts automatically.
4. Continue working while Microsoft Word completes the high-fidelity layout in
   the background.
5. Click a reliable selectable area and edit it directly over the Word layout.
6. Use the right sidebar to format text and review exact and near matches.
7. Choose the editing mode and intended targets.
8. Preview the complete result.
9. Generate new immutable versions in the background.
10. Review the rerendered Word layout, or use structured **Edit** as a fallback.
11. Download or restore versions when needed.

---

## Technology

- **Desktop shell:** Electron
- **Installer:** Electron Builder and NSIS
- **Frontend:** React, TypeScript, Vite, and Quill 2
- **Backend:** FastAPI and Python
- **Document processing:** `python-docx` and PyMuPDF
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
| `DOCUMENTSYNC_RENDER_MAP_CONFIDENCE_THRESHOLD` | `0.90` | Minimum confidence for an interactive layout region |
| `DOCUMENTSYNC_RENDER_MAP_DPI` | `144` | Controlled preview page-image resolution |
| `DOCUMENTSYNC_RENDER_MAP_MAX_PAGES` | `500` | Maximum pages accepted by one render-map job |
| `DOCUMENTSYNC_CORS_ORIGINS` | Local Vite origins | Allowed browser-development origins |

See [`.env.example`](.env.example) for a local development template.

Existing workspaces are upgraded by ordered, one-time schema migrations when the
backend starts. Before an older database is modified, DocSync stores and verifies
a timestamped backup under `workspace/migration-backups`; the five newest
backups are retained. A current workspace skips completed migrations and does
not rerun the version/block-revision backfill. No manual migration command is
normally required.

Schema migration 2 introduced paragraph-level table mappings, schema migration
3 added durable background-job progress fields, schema migration 4 reparses all
immutable versions to add deduplicated, section-aware header/footer blocks, and
schema migration 5 adds durable preview-render jobs. Schema migration 6 adds the
durable structured/Word preview cache and stale-preview recovery metadata.

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
$version = "1.8.0"

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
- High-fidelity Word rendering starts automatically in the background; cached or
  structured Layout content remains available when Word is missing or a preview
  refresh fails.
- The PDF is a fixed visual snapshot and is never modified. Final Word line
  wrapping and pagination appear after a new version is generated and rerendered.
- Low-confidence or ambiguous PDF text mappings remain unavailable for inline
  editing rather than risking selection of the wrong block.
- Header and footer text is editable only when its physical Word paragraph can
  be mapped and rewritten safely.
- Page numbers, page counts, dates, document-property fields, cross-references,
  and other complex fields remain preserved and read-only.
- Header/footer images, logos, watermarks, shapes, text boxes, content controls,
  and nested tables remain preserved and read-only.
- Direct inline editing is limited to reliable mapped paragraphs. Adding,
  deleting, splitting, merging, or moving paragraphs is not supported.
- Authentication, PostgreSQL, hosted cloud storage, and multi-device synchronisation are not yet part of the local desktop release.
- The Windows installer is not yet commercially code-signed.

---

## Roadmap

Planned work includes:

- Additional complex Word structures
- Linux and macOS feasibility
- Commercial code signing
- Automatic update channels
- Hosted authentication
- PostgreSQL
- Cloud storage and synchronisation
- Find and replace

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
