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

## Version 1.3.0

DocSync `v1.3.0` is an editor-stability and usability release.

### Improvements

- Makes the document workspace more compact so more document content remains visible.
- Improves structured-editor recovery after API failures and failed document operations.
- Keeps the editor usable after choosing **OK** or **Cancel** when changing blocks with an unpreviewed draft.
- Adds dismissible error messages that do not block the rest of the workspace.
- Adds visible **Undo** and **Redo** controls for the active block.
- Prevents Quill toolbar controls from being duplicated after editor remounts.
- Improves document-set search and result navigation.
- Improves performance for large documents and table-heavy previews.
- Supports editing of mapped top-level table cells.
- Preserves safe versioning, preview-before-generation, and immutable document history.

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

### Layout, Edit, and Compare

DocSync provides three document workspace modes.

#### Layout

- Displays a read-only Microsoft Word-rendered preview when Microsoft Word is available.
- Uses a structured fallback when Word rendering is unavailable.
- Preserves the original document as the authoritative layout reference.

#### Edit

- Exposes supported headings, paragraphs, list items, and top-level table cells as stable blocks.
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
- Show every affected document and location.
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
4. Select one supported block.
5. Edit the block in the structured editor.
6. Review exact and near matches in **Compare**.
7. Choose the editing mode.
8. Select the intended targets.
9. Preview the complete result.
10. Generate new immutable versions.
11. Download or restore versions when needed.

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

Existing workspaces are upgraded and backfilled when the backend starts. No manual migration command is normally required.

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
$version = "1.3.0"

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
- Some Word structures remain read-only.
- Direct selection of text from the rendered Word layout is not yet available.
- Authentication, PostgreSQL, hosted cloud storage, and multi-device synchronisation are not yet part of the local desktop release.
- The Windows installer is not yet commercially code-signed.

---

## Roadmap

Planned work includes:

- Direct element selection from the Word layout preview
- Broader editing support for complex Word structures
- Stronger file validation and local document protection
- Linux and macOS support
- Hosted authentication
- PostgreSQL support for hosted deployments
- Secure cloud storage and synchronisation
- Automatic desktop update channels

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
