# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

DocSync is a Windows desktop application for applying one confirmed edit across related Microsoft Word documents while preserving the original uploads.

Users can upload a set of related `.docx` files, inspect and search their contents, select repeated text, choose exactly which matches should change, preview the result, and generate updated document versions.

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

### Viewing and selection

- Open and scroll through uploaded documents.
- Use a Microsoft Word-generated layout preview when Word is installed.
- Fall back to a structured selectable preview when Word rendering is unavailable.
- Search visible document text and move between matches.
- Select supported paragraphs, headings, list items, and non-empty table cells.

### Coordinated editing

- Find exact repeated content across multiple documents.
- Include or exclude each matching location before applying an edit.
- Preview every affected document and location.
- Generate new versions without modifying the original uploads.
- Continue editing newly generated workspace versions.

### Downloads and history

- Download one current document.
- Download the complete document set as a ZIP archive.
- Persist document sets, elements, link groups, generated versions, and edit metadata locally.

## How it works

1. Create a document set and upload related Word files.
2. Open a document and switch to the selectable preview.
3. Select a supported paragraph, list item, heading, or table cell.
4. Review the exact matches found in the other documents.
5. Choose which matching locations should be updated.
6. Enter the replacement text and preview the changes.
7. Generate new document versions.
8. Download one document or the complete set.

DocSync always keeps the original uploaded files unchanged.

## Technology

- **Desktop shell:** Electron
- **Installer:** Electron Builder and NSIS
- **Frontend:** React, TypeScript, and Vite
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

### Release `v1.2.1`

From the repository root:

```powershell
git switch main
git pull origin main
git status

npm ci
python -m pip install -r apps/api/requirements-build.txt
npm test

git tag -a v1.2.1 -m "DocSync v1.2.1"
git push origin v1.2.1
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

Before announcing the release, confirm that the release contains:

```text
DocSync-Setup-1.2.1.exe
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
│   ├── api/                       FastAPI backend and DOCX engine
│   ├── desktop/                   Electron application lifecycle
│   ├── web/                       React and TypeScript frontend
│   ├── desktop-ui/                Retained architecture prototype
│   └── template-api/              Retained template-engine prototype
├── build/
│   ├── icon.ico                   Windows installer and application icon
│   └── icon.png                   Development-window icon
├── docs/
│   └── adr/                       Architecture decision records
├── package.json
├── package-lock.json
└── README.md
```

## Core API endpoints

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
GET    /api/document-elements/{element_id}/matches
POST   /api/document-sets/{document_set_id}/preview
POST   /api/document-sets/{document_set_id}/generate
GET    /api/document-sets/{document_set_id}/history
GET    /api/generations/{generation_id}/download
```

## Current limitations

- The Microsoft Word layout preview is read-only.
- Microsoft Word must be installed for high-fidelity layout rendering.
- Direct text selection currently happens in the structured preview rather than over the Word layout.
- Selectable content includes paragraphs, headings, list items, and non-empty top-level table cells.
- Nested tables and complex merged-cell editing are not fully supported.
- Headers, footers, comments, tracked changes, text boxes, and other advanced Word elements are not fully editable.
- Exact matching normalises whitespace and letter case.
- Replacements preserve the paragraph style and first text-run formatting, but complex mixed formatting is not guaranteed.
- The current release is a local desktop application and does not include organisation authentication or cloud storage.
- The Windows installer is not commercially code-signed and may trigger a Microsoft SmartScreen warning.

## Roadmap

Planned future improvements for DocSync include:

- Add a read-only edit history screen.
- Add undo functionality and version restoration.
- Add a richer before-and-after comparison view.
- Add direct element selection within the Microsoft Word layout preview.
- Add a clear Word Preview button.
- Show a visible badge indicating whether the user is viewing the Word - Preview or Structured Preview.
- Improve application security, file validation, error handling, and protection of locally stored documents.
- Add support for Linux and macOS where technically possible.
- Add user authentication for a future hosted version.
- Migrate from SQLite to PostgreSQL for hosted deployments.
- Add secure cloud storage and document synchronisation for a future hosted version.
- Improve the UI with online tools to improve the experience
- Add indentaions and numbered lists 
## Safety model

DocSync is designed around explicit confirmation:

- Original uploads are preserved.
- Matches are shown before changes are generated.
- Users choose which matching locations are included.
- Generated documents are stored as new versions.
- Downloads are produced only after the user confirms the edit.

## Licence

The project is currently marked as `UNLICENSED`. No permission is granted to copy, modify, or distribute the source code unless a licence is added later.
