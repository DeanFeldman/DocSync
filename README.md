# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)
[![Version](https://img.shields.io/badge/version-1.12.0-blue)](#latest-release)

DocSync is a local-first Windows desktop application for safely coordinating edits across related Microsoft Word documents.

Users can upload a group of `.docx` files, view their Word layouts, edit supported content, compare repeated wording across documents, preview proposed changes, and generate new document versions without overwriting the originals.

---

## Download

Download the latest Windows installer from the [DocSync Releases page](https://github.com/DeanFeldman/DocSync/releases/latest).

For most users, download:

```text
DocSync-Setup-latest.exe
```

A completed release contains:

```text
DocSync-Setup-<version>.exe
DocSync-Setup-latest.exe
SHA256SUMS.txt
```

> The installer is not currently commercially code-signed. Windows SmartScreen may display a warning when it is opened.

---

## Latest Release

### Version 1.12.0

DocSync `v1.12.0` makes the rendered Word layout substantially more complete
and adds safe editing for previously invisible blank form fields.

The application now:

- Maps numbered clauses, generated list markers, table-of-contents entries,
  repeated legal wording, and paragraphs split across PDF pages more reliably.
- Detects empty bordered table cells and blank signature/form underlines as real
  selectable Word targets.
- Allows text and soft line breaks inside supported empty, ordinary, and merged
  top-level table cells while preserving the surrounding table structure.
- Preserves multiline plain-text paste instead of flattening it into one line.
- Removes the unhelpful `Select from structure` button and its synthetic layout
  fallback; Layout now exposes only regions tied to the rendered Word document.
- Adds an incremental, restart-safe schema migration for existing workspaces.
  The migration preserves historical revision identities and avoids rebuilding
  the complete version history during desktop startup.

See:

- [v1.12.0 release notes](docs/v1.12.0-release-notes.md)
- [v1.12.0 manual test plan](docs/v1.12.0-manual-testing.md)
- [Batch editing and complete Word text inventory](docs/batch-find-replace-text-inventory.md)
- [Measured batch performance](docs/evidence/v1.11.0-batch-find-replace-performance.md)

---

## Main Features

### Batch Find & Replace

- Discover every occurrence separately across logical Word text, including text
  split across runs and supported complex structures.
- Report protected text as read-only with a specific reason instead of silently
  omitting it.
- Review and select editable occurrences across all, current, or selected
  documents.
- Combine Find & Replace and reviewed rich-editor changes in durable pending
  batches.
- Detect overlaps and stale versions before writing files.
- Generate at most one new immutable version per affected document and keep an
  auditable batch history.

See [Batch editing and complete Word text inventory](docs/batch-find-replace-text-inventory.md).

### Document Sets

- Upload between 2 and 20 related `.docx` documents.
- Create and reopen locally stored document sets.
- Add documents to an existing set.
- Remove individual documents.
- Delete complete document sets.
- Search across the current version of every document.
- Navigate directly to matching document content.
- Download individual documents or the complete set.
- Switch between light and dark mode.

### Word Layout Preview

- Render high-fidelity Word layouts in the background.
- Cache previews using immutable document versions.
- Reuse previously generated previews.
- Display document pages inside a scrollable workspace.
- Resolve generated numbering, TOC decorations, repeated text, and cross-page
  paragraphs with contextual PDF mapping.
- Map blank bordered table cells and long signature/form underlines geometrically.
- Continue using the application while rendering completes.
- Retry a failed Word preview without substituting a synthetic document layout.

### Controlled Editing

DocSync maps supported Word content into stable editable blocks.

Supported content includes:

- Headings
- Body paragraphs
- Ordered lists
- Unordered lists
- Top-level table paragraphs
- Empty bordered table cells and mapped signature/form lines
- Supported merged top-level table paragraphs
- Header paragraphs
- Footer paragraphs

Supported formatting includes:

- Bold
- Italic
- Underline
- Heading levels
- Ordered and unordered lists
- Indentation
- Alignment
- Soft line breaks within one Word paragraph or table cell

Editing is intentionally restricted to operations that can be mapped safely back to the original Word document.

### Inline Layout Editing

Reliable text regions can be selected directly from the Word layout.

When a supported paragraph is selected:

1. A controlled Quill editor opens over the selected content.
2. The user edits the block, including multiline typing or plain-text paste.
3. Matching wording is identified across the document set.
4. The user chooses which documents should be updated.
5. DocSync previews the complete result.
6. New immutable document versions are generated.

Low-confidence or ambiguous layout regions remain read-only.

Pressing Enter creates a Word line break inside the selected block. It does not
insert a new structural Word paragraph, table row, or table column.

### Compare Related Documents

DocSync can:

- Find exact repeated wording.
- Find bounded near-match candidates.
- Display similarity scores.
- Highlight word-level differences.
- Require confirmation before changing near matches.
- Include or exclude individual targets.

### Editing Modes

#### Shared Wording

Apply the active replacement to selected exact matches across the document set.

#### Per-Document Values

Provide a different replacement value for each selected document.

#### Whole-Paragraph Override

Change only the selected paragraph and detach it from future shared wording updates.

### Preview and Generation

Before changing any document, DocSync shows:

- Every affected document
- The selected editing mode
- The original text
- The proposed replacement
- The exact Word location
- Included and excluded targets

Confirmed changes are generated through durable background jobs.

### Downloads and Version History

- Download the current document.
- Download any recorded version.
- Download the complete document set as a ZIP file.
- Download generated operation output.
- Inspect version lineage.
- Restore an earlier version as a new current version.
- Keep all previous versions available.

---

## Safety Model

DocSync is designed around controlled document editing.

- Original uploaded files are never overwritten.
- Confirmed edits create new immutable versions.
- Every supported editor block is mapped to a stored Word element.
- Preview operations do not write new files.
- Stale edits are rejected when a document changes before generation.
- Failed generation operations are rolled back.
- Unsupported Word structures are preserved.
- Unsafe or ambiguous structures remain read-only.
- Local documents stay on the user's computer.

---

## How It Works

1. Create a document set.
2. Upload related Microsoft Word documents.
3. Select a document.
4. Review its structured or high-fidelity Word layout.
5. Select a supported paragraph.
6. Edit the text and formatting.
7. Review exact and near matches.
8. Choose the editing mode and targets.
9. Preview the resolved changes.
10. Generate new immutable versions.
11. Download or restore document versions when required.

---

## Technology Stack

| Area | Technology |
| --- | --- |
| Desktop shell | Electron |
| Installer | Electron Builder and NSIS |
| Frontend | React, TypeScript, Vite |
| Rich-text editor | Quill 2 |
| Backend | FastAPI and Python |
| Document processing | `python-docx` and PyMuPDF |
| Database | SQLAlchemy and SQLite |
| Backend packaging | PyInstaller |
| Automation | GitHub Actions |

The packaged Windows application includes the Electron runtime and frozen Python backend. Installed users do not need Node.js, npm, Python, or development tools.

---

## Requirements

### Installed Application

- Windows 10 or Windows 11
- Microsoft Word desktop is recommended for high-fidelity layout rendering

Microsoft Word is not required for the structured fallback preview.

### Development

- Windows 10 or Windows 11
- Node.js 22 or newer
- Python 3.11 or newer
- npm
- Microsoft Word desktop for high-fidelity rendering

---

## Configuration

Copy `.env.example` when configuring a local development environment.

```powershell
Copy-Item .env.example .env
```

Important environment variables include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCUMENTSYNC_DATA_DIR` | `./data` | Local database, uploads, output, and cache directory |
| `DOCUMENTSYNC_DATABASE_URL` | `sqlite:///./data/documentsync.db` | Database connection |
| `DOCUMENTSYNC_CORS_ORIGINS` | Local Vite origins | Allowed development origins |
| `DOCUMENTSYNC_MAX_FILE_BYTES` | `10485760` | Maximum size of each uploaded file |
| `DOCUMENTSYNC_MAX_FILES_PER_SET` | `20` | Maximum documents in a set |
| `DOCUMENTSYNC_RENDER_MAP_CONFIDENCE_THRESHOLD` | `0.90` | Minimum confidence for interactive layout regions |
| `DOCUMENTSYNC_RENDER_MAP_DPI` | `144` | Preview image resolution |
| `DOCUMENTSYNC_RENDER_MAP_MAX_PAGES` | `500` | Maximum pages in one render-map job |
| `VITE_API_URL` | `http://localhost:8001/api` | Frontend API URL |

DocSync uses SQLite by default. No external database server or API key is required for the local desktop version.

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
Schema migration 7 adds a trigger-maintained SQLite FTS5 trigram index for
current-version document search, with a safe substring fallback when FTS5 is
not available in the embedded SQLite build. Schema migration 8 adds durable
reviewed edit batches. Schema migration 9 additively backfills empty table-field
targets in current versions without deleting or recreating historical revisions.

If migration fails, the active database is restored automatically and the
startup dialog shows the workspace and recovery-backup paths. Do not move or
delete the workspace. Close DocSync before any manual restore, preserve the
active `documentsync.db`, then copy the support-selected backup into place as
`documentsync.db`. See the
[v1.4.2 recovery notes](docs/v1.4.2-release-notes.md#manual-recovery).

---

## Run Locally

Run the following commands from the repository root in Windows PowerShell:

```powershell
git clone https://github.com/DeanFeldman/DocSync.git
cd DocSync

npm.cmd install
python -m pip install -r apps/api/requirements.txt

npm.cmd test
npm.cmd run build:web
npm.cmd start
```

`npm.cmd start` launches the already-built React frontend, starts the local
FastAPI service, and opens DocSync in an Electron window. It intentionally does
not rebuild production assets on every launch.

For the live development stack (Vite hot reload, FastAPI, and Electron), run:

```powershell
npm.cmd run dev
```

The development command uses the ignored `.artifacts/dev-workspace` directory
unless `DOCUMENTSYNC_DATA_DIR` is explicitly set. Production builds remain
available through `npm.cmd run build:web` or `npm.cmd run build:desktop`.

### PowerShell Execution-Policy Error

When PowerShell blocks `npm.ps1`, use `npm.cmd` instead:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Alternatively, allow scripts only for the current session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## Run Frontend and Backend Separately

### Backend

```powershell
cd apps/api

python -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8001
```

FastAPI documentation:

```text
http://localhost:8001/docs
```

### Frontend

Open another PowerShell terminal:

```powershell
cd apps/web

npm.cmd install
npm.cmd run dev
```

Open:

```text
http://localhost:5173
```

---

## Testing

Run all tests:

```powershell
npm.cmd test
```

Run Node and desktop tests:

```powershell
npm.cmd run test:node
```

Run backend tests:

```powershell
python -m pip install -r apps/api/requirements.txt
python -m pytest apps/api
```

Build-check the frontend:

```powershell
npm.cmd run build:web
```

Run the packaged backend smoke test:

```powershell
npm.cmd run smoke:api:win
```

---

## Build the Windows Installer

Install the build dependencies:

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

An unpacked build may also be available under:

```text
release/v1/win-unpacked/
```

Do not commit the `release/` directory. Installer files should be uploaded to GitHub Releases.

---

## Release Process

The release workflow runs when a tag beginning with `v` is pushed.

Example:

```powershell
$version = "1.12.0"

git switch main
git pull origin main
git status

npm.cmd ci
python -m pip install -r apps/api/requirements-build.txt
npm.cmd test

git tag -a "v$version" -m "DocSync v$version"
git push origin "v$version"
```

The GitHub Actions release workflow will:

1. Check out the tagged source.
2. Install Node.js and Python dependencies.
3. Set the package version from the Git tag.
4. Run automated tests.
5. Build the Windows installer.
6. Create `DocSync-Setup-latest.exe`.
7. Generate `SHA256SUMS.txt`.
8. Create the GitHub Release.
9. Upload the installer and checksums.

Use semantic version tags:

```text
v1.0.0  Initial stable release
v1.1.0  Backwards-compatible feature release
v1.1.1  Backwards-compatible fix release
v2.0.0  Breaking release
```

Do not reuse or move a published release tag.

---

## Project Structure

```text
DocSync/
├── .github/
│   └── workflows/
├── apps/
│   ├── api/
│   ├── desktop/
│   ├── desktop-ui/
│   ├── template-api/
│   └── web/
├── build/
├── docs/
├── scripts/
├── .env.example
├── compose.yaml
├── package.json
├── package-lock.json
└── README.md
```

---

## Core API Areas

The local backend provides endpoints for:

- Health checks
- Document-set management
- Document upload and deletion
- Word document rendering
- Structured editor content
- Exact and near matching
- Comparison decisions
- Preview operations
- Version generation
- Downloads
- Version history
- Version restoration
- Global search

Open the FastAPI documentation during development for the current endpoint list:

```text
http://localhost:8001/docs
```

---

## Known Limitations

- The packaged desktop release currently targets Windows.
- High-fidelity layout rendering works best when Microsoft Word desktop is installed.
- The PDF preview is a fixed visual snapshot and is not modified directly.
- Final Word wrapping and pagination appear after generation and rerendering.
- Low-confidence or ambiguous text mappings cannot be edited inline.
- Layout editing is limited to reliably mapped Word blocks and blank fields.
- Soft line breaks within one block are supported. Adding, deleting, splitting,
  merging, or moving structural Word paragraphs, rows, or columns is not.
- Complex fields, drawings, text boxes, shapes, watermarks, and content controls
  remain read-only in Layout editing even when Find can discover their text.
- Nested tables and table cells containing protected objects remain read-only in
  Layout editing.
- Authentication and multi-user collaboration are not included.
- PostgreSQL, cloud storage, and document synchronisation are not included in the local desktop release.
- The Windows installer is not commercially code-signed.

---

## Roadmap

Planned improvements include:

- Support for additional complex Word structures
- Structural paragraph and table row/column operations
- Linux and macOS feasibility
- Commercial code signing
- Automatic update channels
- User authentication for a hosted version
- PostgreSQL support
- Secure cloud storage
- Multi-device document synchronisation

---

## Contributing

1. Create a branch from `main`.
2. Make one focused change.
3. Run the complete test suite.
4. Build-check the frontend.
5. Push the branch.
6. Open a pull request.

Example:

```powershell
git switch main
git pull origin main
git switch -c feat/example-change

npm.cmd test
npm.cmd run build:web

git add .
git commit -m "feat: describe the change"
git push -u origin feat/example-change
```

Do not commit:

- Local databases
- Uploaded user documents
- Generated installers
- Environment files containing secrets
- Passwords, tokens, or private certificates

---

## Security

DocSync is a local-first application. User files and the SQLite workspace remain on the local computer unless the user manually transfers them.

Never commit:

- API keys
- Passwords
- Access tokens
- Private certificates
- Real user documents
- Production environment files
- Generated release installers
- Local database files

Use environment variables and `.env.example` for local configuration templates.

Report exposed credentials immediately and rotate any real secret that entered Git history.

---

## Author

**Dean Feldman**

---

## License

This repository is currently marked as `UNLICENSED`.

Copyright © Dean Feldman.
