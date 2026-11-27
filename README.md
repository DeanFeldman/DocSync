# DocSync

[![Desktop CI](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/phase3-desktop.yml)
[![Release](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml/badge.svg)](https://github.com/DeanFeldman/DocSync/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/DeanFeldman/DocSync)](https://github.com/DeanFeldman/DocSync/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)

DocSync is a local-first Windows desktop application for safely coordinating edits across related Microsoft Word documents.

Upload related DOCX files, edit them in ONLYOFFICE, and sync matching paragraph wording across the set. DocSync keeps the originals and every saved version.

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

## Local ONLYOFFICE editor

Selecting a file opens the embedded editor. Set up a trusted local ONLYOFFICE
Docs service once. DocSync starts or reuses it from the normal Windows
shortcut. See the [Windows setup guide](docs/local-onlyoffice-windows.md)
for configuring the service. To launch a built
source checkout with a service already configured, run:

```powershell
$env:DOCSYNC_ONLYOFFICE_URL = 'http://127.0.0.1:8080'
$env:DOCSYNC_ONLYOFFICE_SECRET = '<the local document server JWT secret>'
npm start
```

Set the loopback origin to the exact origin that ONLYOFFICE uses in its saved
file URLs. DocSync accepts loopback HTTP origins with an explicit port and
a shared secret of at least 24 characters. Run the service
where `127.0.0.1` reaches DocSync directly, or use a host-networked environment
with that property. The standard installer does not bundle this dependency.

With **Matching files** selected, click **Save** in ONLYOFFICE to save the
edited file and update unambiguous paragraph matches in the set. Matching
compares wording while ignoring spacing differences. Deleting a shared
paragraph removes it from matching locations where DocSync can safely do so.
New paragraphs and list items sync at matching insertion points, and each
matching list continues its own numbering. **Review table deletions** lets you
choose whether to remove corresponding tables that contain file-specific text.
**This file only** saves the current file. The toolbar shows updated files and
identifiable skipped matches. Formatting-only changes stay in the file you edited.

## Local workspaces and manual transfers

DocSync opens a workspace stored on this device without requiring an account.
If you already used an account-based local workspace, you can open it from
**Local data**. DocSync keeps previous workspace folders on this device.

1. Choose **Local data → Export all DocSync data**. Save the ZIP.
2. Transfer the file yourself via USB or another channel you choose.
3. On the other device, choose **Local data → Import backup ZIP**, select the ZIP,
   review the reported contents, and confirm.

The versioned ZIP contains the workspace database, originals, generated files,
and appearance preference. DocSync regenerates previews and caches. The ZIP
contains your documents, so store it somewhere you trust. Import opens a
separate workspace and keeps any workspace already on the destination.
DocSync does not automatically transfer or restore this data.

- [Download statistics](analytics/README.md)
- [Supabase analytics setup](docs/analytics-supabase.md)
- [Batch editing and complete Word text inventory](docs/batch-find-replace-text-inventory.md)
- [Measured batch performance](docs/evidence/v1.11.0-batch-find-replace-performance.md)

---

## Main Features

### Download Statistics

The scheduled collector stores public GitHub Release installer download
snapshots in `analytics/download-history.csv` and generated metrics in
`analytics/summary.json`. These are asset download counts only; DocSync does
not collect in-app telemetry.

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

### Downloads and Version History

- Download the current document.
- Download any recorded version.
- Inspect version lineage.
- Restore an earlier version as a new current version.
- Keep all previous versions available.

---

## Safety Model

- Every save creates immutable document versions and preserves the uploaded originals.
- Related wording updates use exact, unambiguous matches and preserve each file's other paragraphs.
- DocSync rejects stale saves and rolls back a failed multi-document write.
- Documents stay on this device and the local ONLYOFFICE service.

## How It Works

1. Upload related Word documents as a set.
2. Select a file to open ONLYOFFICE.
3. Choose whether wording changes apply to matching files or this file only.
4. Edit and click **Save** in ONLYOFFICE.
5. Download or restore versions through **Version history** when needed.

## Technology Stack

| Area | Technology |
| --- | --- |
| Desktop shell | Electron |
| Installer | Electron Builder and NSIS |
| Frontend | React, TypeScript, Vite |
| Word editor | ONLYOFFICE Docs |
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
$version = "1.18.1"

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
- The editor needs a running local ONLYOFFICE Docs service.
- Automatic cross-file updates cover exact matches for wording edits in existing paragraphs.
- Authentication and multi-user collaboration are not included.
- PostgreSQL, cloud storage, and document synchronisation are not included in the local desktop release.
- The Windows installer is not commercially code-signed.

---

## Roadmap

Planned improvements include:

- Linux and macOS feasibility
- Commercial code signing
- Automatic update channels
- User authentication for a hosted version
- PostgreSQL support
- Secure cloud storage
- Multi-device document synchronisation
- OneDrive Integration — Open documents from OneDrive, edit them safely in DocSync, and sync approved changes back.

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
