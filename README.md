# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

DocSync is a local-first Windows desktop application for safely coordinating edits
across related Microsoft Word documents.

Upload a set of `.docx` files, work with supported content in a structured rich-text
editor, compare exact and near matches, preview every target, and generate immutable
new document versions. Original uploads are never overwritten.

## Download

Download the latest Windows installer from the [GitHub Releases page](https://github.com/DeanFeldman/DocSync/releases/latest).

Each release contains:

- `DocSync-Setup-<version>.exe` — the installer for a specific version.
- `DocSync-Setup-latest.exe` — a copy of the newest installer.
- `SHA256SUMS.txt` — SHA-256 checksums for verifying the downloads.

For most users, download:

```text
DocSync-Setup-latest.exe
```

> The installer is not commercially code-signed yet, so Windows SmartScreen may display a warning.

> The editable-document workspace described below is currently available in the
> source build. The latest published installer remains `v1.2.1` until the next
> release is tagged.

## Version 1.2.1

DocSync `v1.2.1` is a maintenance release focused on making large documents and table-heavy previews faster and more reliable.

### Improvements

- Loads document preview pages progressively instead of rendering every page immediately.
- Reduces database work when opening document sets containing many exact-match groups.
- Keeps the total exact-match group count visible without loading every group into the initial response.
- Improves table rendering when source tables use sparse row or column positions.
- Uses browser content visibility to reduce the rendering cost of off-screen pages.
- Preserves search navigation by loading the required page before scrolling to a result.

## Main features

### Document sets

- Upload between 2 and 20 related `.docx` files as a document set.
- Reopen saved document sets from the local workspace library.
- Add documents to an existing set.
- Remove individual documents or delete a complete set.
- Search extracted text across every document in the current set.

### Layout, Edit, and Compare

- **Layout** shows a read-only Microsoft Word-rendered preview when Word is
  installed, with a structured fallback when rendering is unavailable.
- **Edit** exposes supported headings, paragraphs, list items, and top-level table
  cells as stable, version-scoped blocks.
- **Compare** shows exact and near matches with similarity scores and word-level
  difference spans.
- The Quill 2 editor preserves supported bold, italic, underline, heading, list,
  indentation, and alignment metadata.
- One mapped Word block is edited at a time. The editor stays pinned at the top
  while the document block list scrolls on desktop-sized screens.

### Coordinated editing

- Find exact matches using Unicode NFKC normalisation, case folding, trimming,
  whitespace collapsing, and element type.
- Review bounded near-match candidates and explicitly confirm or ignore them.
- Apply shared wording to exact matches, provide a distinct value for each selected
  document, or override and detach only the source paragraph.
- Include or exclude every eligible target before generation.
- Preview the resolved result for every affected document without writing files or
  database records.
- Reject stale generation requests when a document changed after preview.
- Write a confirmed batch atomically as new immutable document versions.

### Downloads and history

- Download the current document or any recorded version.
- Download the complete document set as a ZIP archive.
- Download the output of an editor operation as a ZIP archive.
- Inspect version lineage and the edit history for a document set.
- Continue editing from newly generated current versions.

## How it works

1. Create a document set and upload related Word files.
2. Use **Layout** to inspect the Word document or **Edit** to select a supported
   block.
3. Edit that block with the pinned rich-text editor.
4. Open **Compare** to review exact and near matches and their differences.
5. Choose shared wording, per-document values, or a whole-paragraph override.
6. Select every intended target and explicitly confirm any near matches.
7. Preview the resolved output for every affected document.
8. Generate new versions from the same base versions used by the preview.
9. Download a version, the operation ZIP, or the current document set.

DocSync always keeps the original uploaded files unchanged.

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

## Requirements

### Installed application

- Windows 10 or Windows 11
- Microsoft Word desktop is recommended for the high-fidelity layout preview

Microsoft Word is not required for the structured fallback preview.

### Development

- Windows 10 or Windows 11
- Node.js 22 or newer
- Python 3.11 or newer
- npm
- Microsoft Word desktop for the high-fidelity layout preview

## Configuration and local data

The backend reads configuration from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCUMENTSYNC_DATA_DIR` | `./data` | SQLite database, uploads, generated files, and render cache |
| `DOCUMENTSYNC_DATABASE_URL` | SQLite inside the data directory | Database connection |
| `DOCUMENTSYNC_MAX_FILE_BYTES` | `10485760` | Maximum upload size per file |
| `DOCUMENTSYNC_MAX_FILES_PER_SET` | `20` | Maximum documents in a set |
| `DOCUMENTSYNC_NEAR_MATCH_THRESHOLD` | `0.82` | Minimum near-match similarity score |
| `DOCUMENTSYNC_NEAR_MATCH_CANDIDATE_LIMIT` | `25` | Maximum near-match candidates inspected |
| `DOCUMENTSYNC_CORS_ORIGINS` | Local Vite origins | Allowed browser-development origins |

See [`.env.example`](.env.example) for a local development template. Existing
workspaces are upgraded and backfilled on backend startup; no manual migration
command is required.

## Run locally

Run these commands from the repository root in Windows PowerShell:

```powershell
cd "C:\path\to\DocSync"

npm install
python -m pip install -r apps/api/requirements.txt
npm test
npm start
```

`npm start` builds the React frontend, starts the local FastAPI service, and opens DocSync in an Electron window.

### PowerShell execution-policy error

If PowerShell blocks `npm.ps1`, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Alternatively, allow scripts only for the current PowerShell session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## Run the frontend and backend separately

### Backend

```powershell
cd apps/api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8001
```

FastAPI documentation is then available at:

```text
http://localhost:8001/docs
```

### Frontend

Open another terminal:

```powershell
cd apps/web
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

## Tests

Run all tests from the repository root:

```powershell
npm test
```

Run the backend tests directly:

```powershell
python -m pip install -r apps/api/requirements.txt
python -m pytest apps/api
```

Build-check the frontend:

```powershell
npm run build:web
```

The editor acceptance suite covers rich Delta extraction, exact and near matching,
persisted decisions, preview side-effect safety, immutable version lineage,
per-document generation, full-override detachment, stale-version conflicts, and
generation rollback.

## Build the Windows installer

Install the build requirements:

```powershell
python -m pip install -r apps/api/requirements-build.txt
npm install
```

Build the installer:

```powershell
npm run dist:win
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

## Release process

The release workflow runs whenever a tag beginning with `v` is pushed. It reads the application version from the tag, so the source `package.json` version does not need to be changed manually before every release.

### Create a release

From the repository root:

```powershell
$version = "1.3.0" # Choose the next unused semantic version.

git switch main
git pull origin main
git status

npm ci
python -m pip install -r apps/api/requirements-build.txt
npm test

git tag -a "v$version" -m "DocSync v$version"
git push origin "v$version"
```

After the tag is pushed, open the repository's **Actions** tab and follow the **DocSync release** workflow.

The workflow will:

1. Check out the tagged source code.
2. Install the Node.js and Python dependencies.
3. Set the package version from the Git tag.
4. Run the automated tests.
5. Build the Windows installer.
6. Create the `DocSync-Setup-latest.exe` copy.
7. Generate `SHA256SUMS.txt`.
8. Create the GitHub Release and upload all release files.

Before announcing the release, confirm that it contains:

```text
DocSync-Setup-<version>.exe
DocSync-Setup-latest.exe
SHA256SUMS.txt
```

The workflow is defined in:

```text
.github/workflows/release.yml
```

Use semantic version tags:

```text
v1.0.0  Initial stable release
v1.1.0  Backwards-compatible features
v1.1.1  Backwards-compatible fixes
v2.0.0  Breaking changes
```

Do not reuse or move a published version tag. Create a new tag for every release.

## Project structure

```text
DocSync/
├── .github/
│   └── workflows/
│       ├── phase3-desktop.yml     Test and installer build workflow
│       └── release.yml            Tag-triggered GitHub Release workflow
├── apps/
│   ├── api/                       FastAPI, version model, matching, and DOCX engine
│   ├── desktop/                   Electron application lifecycle
│   ├── web/                       React, TypeScript, and Quill editor
│   ├── desktop-ui/                Retained architecture prototype
│   └── template-api/              Retained template-engine prototype
├── build/
│   ├── icon.ico                   Windows installer and application icon
│   └── icon.png                   Development-window icon
├── docs/
│   ├── adr/                       Architecture decision records
│   └── editable-document-editor.md
├── package.json
├── package-lock.json
└── README.md
```

## Core API endpoints

Workspace and rendering:

```text
GET    /api/health
GET    /api/document-sets
POST   /api/document-sets
GET    /api/document-sets/{document_set_id}
DELETE /api/document-sets/{document_set_id}
POST   /api/document-sets/{document_set_id}/documents
DELETE /api/document-sets/{document_set_id}/documents/{document_id}
GET    /api/document-sets/{document_set_id}/search
POST   /api/documents/{document_id}/render
GET    /api/document-versions/{version_id}/pages
GET    /api/document-versions/{version_id}/rendered-file
GET    /api/documents/{document_id}/download
GET    /api/document-sets/{document_set_id}/history
```

Structured editor, matching, and versioning:

```text
GET    /api/document-versions/{version_id}/editor-content
GET    /api/document-elements/{element_id}/matches
GET    /api/document-elements/{element_id}/similar-matches
POST   /api/document-elements/{element_id}/compare
POST   /api/document-elements/{element_id}/match-decisions
POST   /api/document-sets/{document_set_id}/editor-preview
POST   /api/document-sets/{document_set_id}/editor-generate
GET    /api/documents/{document_id}/versions
GET    /api/document-versions/{version_id}/download
GET    /api/editor-operations/{operation_id}/download
```

Compatibility endpoints retained for the original exact-match client:

```text
POST   /api/document-sets/{document_set_id}/preview
POST   /api/document-sets/{document_set_id}/generate
GET    /api/generations/{generation_id}/download
```

For the version model, editor contract, and supported-content boundary, see
[Editable document editor](docs/editable-document-editor.md).

## Current limitations

- Layout is read-only, and direct block selection happens in Edit rather than over
  the Word-rendered page.
- Microsoft Word must be installed for high-fidelity layout rendering.
- Exactly one stable block is edited at a time. Insertion, deletion, split, merge,
  reorder, Enter-created blocks, and multi-line paste are intentionally disabled.
- Editable content is limited to supported paragraphs, headings, list items, and
  non-empty top-level table cells with a stable write-back location.
- Nested or complex merged tables, headers, footers, comments, tracked changes,
  text boxes, fields, footnotes, endnotes, shapes, and similar advanced Word
  structures are read-only or diagnostic-only.
- Supported Quill formatting is limited to headings, ordered and unordered lists,
  indentation, alignment, bold, italic, and underline. Other mixed or advanced
  formatting is preserved only where the block is not rewritten.
- Shared wording applies to exact matches. A confirmed near match must use
  per-document mode so branch-specific wording is not erased accidentally.
- The application is local-only and does not include organisation authentication
  or cloud storage.
- The Windows installer is not commercially code-signed and may trigger a
  Microsoft SmartScreen warning.

## Roadmap

Planned future improvements for DocSync include:

- Add undo functionality and version restoration.
- Add direct element selection within the Microsoft Word layout preview.
- Expand safe editing support to more complex Word structures.
- Improve application security, file validation, error handling, and protection
  of locally stored documents.
- Add support for Linux and macOS where technically possible.
- Add user authentication for a future hosted version.
- Migrate from SQLite to PostgreSQL for hosted deployments.
- Add secure cloud storage and document synchronisation for a future hosted
  version.
- Establish an update channel for maintained online distribution.

## Safety model

DocSync is designed around explicit confirmation:

- Original uploads are immutable.
- Layout remains the visual source of truth for unsupported Word content.
- Exact matches are reviewable; near matches are never automatic targets and their
  decisions are persisted against version-specific element pairs.
- Preview is side-effect free: it creates no files, versions, or operation records.
- Users choose every target and review the resolved output before generation.
- Generation requires the same base version IDs used for preview and returns
  `409 Conflict` if a document head is stale.
- DOCX files are staged and validated before the database transaction advances any
  document heads. A failed batch is rolled back and staged output is removed.
- Every successful edit creates new document versions with parent lineage and an
  auditable editor operation.

## Licence

The project is currently marked as `UNLICENSED`. No permission is granted to copy, modify, or distribute the source code unless a licence is added later.
