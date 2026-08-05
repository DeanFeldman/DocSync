# Document opening and generation performance report

## Results

The version-generation benchmark uses three DOCX files with 300 body blocks each
and updates one shared block in every file. Both measurements use the same script,
machine, Python process shape, and synchronous compatibility endpoint.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Generation runs | 742.89, 782.75, 814.59 ms | 535.79, 447.44, 523.78 ms | — |
| Generation median | 782.75 ms | 523.78 ms | 33.1% faster |
| Generation maximum | 814.59 ms | 535.79 ms | 34.2% lower |

The post-change document-opening benchmark uses a 1,000-block DOCX. Creating the
SQLite structured-preview cache took 82.23 ms. Five cache-hit requests took 25.81,
26.98, 32.42, 47.31, and 26.60 ms, for a 26.98 ms median. Microsoft Word conversion
is not available in the headless benchmark, so there is no trustworthy pre-change
Word-conversion number. Before this change the UI hid already-fetched structured
content until Word conversion and page-map generation completed; after the change,
the 27 ms median cached structured response can become the first visible content.

The production main JavaScript chunk fell from 302.77 kB to 297.12 kB. Quill is a
separate 200.03 kB lazy chunk and is not part of the initial application chunk.

## Root causes

Document opening was gated on several independent tasks: editor-content loading,
DOCX-to-PDF conversion through Word, render-map image creation, coordinate matching,
and Quill setup. The UI discarded useful intermediate states, its preview resource
cache existed only in memory, the backend PDF cache did not persist source identity,
and overlapping effects could join or start the same work without one consistent
resource key. The overlay also waited for page PNGs instead of showing readable
structured text first.

Generation parsed each generated DOCX up to three times, rebuilt paragraph/table/
header/style lookups for every target, recreated every current block identity,
rebuilt every exact-match group in the workspace, recompressed already-compressed
DOCX ZIP packages, and serialized the complete workspace for an async job whose
caller only needed the changed document rows. Validation also ran before an
overlapping duplicate submission was rejected.

## New document-opening flow

1. Selecting a document synchronously checks the version-keyed in-memory resource
   cache and renders it when present.
2. Editor content is fetched through a request-deduplicating resource cache and is
   displayed as readable structured text as soon as it arrives.
3. The preview-job endpoint checks the SQLite preview record and its disk PDF. A
   matching source checksum, byte size, nanosecond modification time, PDF size, and
   PDF modification time is a fresh hit.
4. A fresh or stale cached Word preview is returned in the initial job response.
   Stale content remains visible with **Updating preview…** while one background job
   refreshes it. **Opening document…** is used only when no content exists.
5. Page images and coordinate matching run after text is visible. Page images use
   intersection-based lazy loading; the first two pages are eager.
6. Selecting an editable block dynamically imports Quill and Snow CSS. A module-level
   promise deduplicates imports, while the block/reset-keyed effect creates only one
   live editor instance and removes Quill/DOM listeners on cleanup.
7. A successful conversion atomically replaces the PDF and updates SQLite. A failed
   refresh records the error but leaves the previous cached payload and PDF usable.
8. Request IDs, abort controllers, active-document checks, version-keyed resource
   keys, shared in-flight promises, and backend active-job checks prevent stale or
   duplicate work from replacing the selected document.

The SQLite cache stores structured and Word-preview JSON plus source/PDF identity.
PDF and page-image binaries remain in the existing render directories to avoid
bloating SQLite. Immutable version IDs isolate generated documents; identity fields
also detect an externally changed source at the same version path.

## New generation flow

The active UI still queues a durable background operation immediately. A synchronous
ref guard and disabled button stop double-clicks in React, while the backend rejects
overlapping document IDs before full validation. Each affected DOCX is read once,
its paragraphs/tables/header-footer relationships/styles are indexed once, changes
are applied, the package is written once, and the one validation parse is reused for
block extraction. Stable locations retain `DocumentElement` IDs. Only old/new exact
hashes whose membership changed are rebuilt. Database inserts are batched, the output
bundle stores already-compressed DOCX packages without recompressing them, and preview
jobs remain deferred until the new versions commit. Async status returns only
`document_updates`; the synchronous legacy endpoint keeps its full-workspace response.

Generated DOCX behaviour remains covered for text, inline formatting, headings,
ordered/unordered lists, indentation, alignment, tables, linked headers/footers,
images and package relationships, version lineage, restore, audit history, and
rollback on failure.

## Quill audit

Quill is retained because the reachable Layout editor constructs it in
`InlineLayoutEditor.tsx`, uses its toolbar/history/format APIs, and sends Delta data
through editor requests. `editorUtils.ts` normalizes and converts those Deltas. The
backend validates the safe Delta subset, applies it to DOCX runs/paragraph properties,
and stores current and before/after Delta JSON in `document_block_revisions` and
`editor_operation_targets`. Existing SQLite workspaces therefore depend on the Delta
format.

`QuillBlockEditor.tsx` was obsolete and unreachable and has been deleted. Its CSS and
contract-test references were removed or redirected to the reachable inline editor.
The `Boolean(0)` legacy viewer/editor branch in `App.tsx`, its private state/effects/
handlers/dialogs, and its fallback-view prop were also removed. No dependency was
removed: Quill, React, and React DOM are all reachable; Quill now loads only after an
editable block is selected.

## Database migration

Schema migration 6, `durable_document_preview_cache`, adds
`document_preview_cache` and adds `stale_preview_available` to existing
`preview_render_jobs`. The cache row is keyed by immutable `version_id` and records
the document ID, source checksum/size/mtime, PDF size/mtime, structured and Word
preview JSON, the last refresh error, and timestamps. Existing startup migration and
backup rules apply automatically; no manual SQL is required.

## Timing labels

Backend logs include `docsync.document_fetch_timing`,
`docsync.word_render_timing`, `docsync.docx_conversion_timing`,
`docsync.render_map_timing`, `docsync.generation_queue_timing`,
`docsync.generation_document_timing`, and `docsync.generation_timing`. Relevant fetch
endpoints also expose `Server-Timing` and `X-DocSync-Preview-Cache` headers.

Frontend console measurements include `docsync.document_fetch_timing`,
`docsync.preview_render_timing`, `docsync.document_ready_timing`,
`docsync.quill_import_timing`, `docsync.editor_initialization_timing`, and the
`DocuSync generation queued/ready` events.

## Verification performed

```powershell
python -m compileall -q apps/api/app apps/api/scripts
python -m pytest apps/api -q
npm.cmd run test:node
npm.cmd run build --workspace documentsync-web
npm.cmd run build:api:win
npm.cmd run smoke:api:win
python apps/api/scripts/benchmark_editor_generation.py --data-dir .artifacts/generation-after-final-20260805 --documents 3 --blocks 300 --runs 3
python apps/api/scripts/benchmark_document_opening.py --data-dir .artifacts/document-opening-after-20260805 --blocks 1000 --cached-runs 5
```

The final results were 63 passing backend tests, 39 passing Node/frontend/desktop
contract tests, a successful TypeScript production build, a successful PyInstaller
Windows backend build, and a successful packaged-backend smoke test. The project has
no configured standalone frontend lint script; TypeScript compilation and production
bundling are the available static frontend checks. PyInstaller reported missing
optional NumPy/SciPy/MySQL/Postgres hooks, but the local SQLite executable built and
passed its smoke test.

To run the desktop application:

```powershell
npm.cmd start
```

For separate development processes:

```powershell
npm.cmd run start:api
npm.cmd run dev --workspace documentsync-web -- --host 127.0.0.1
```

## Manual verification

1. Upload a new two-document workspace. Select each new document and confirm readable
   structured text appears before Word pages, followed by the full Layout preview.
2. Reopen the same document. Confirm it appears immediately and the network response
   reports `X-DocSync-Preview-Cache: hit` or the console reports a cached preview.
3. Generate a new version and open it. Confirm the new immutable version gets its own
   cache and that returning to the previous version reuses its old cache. The automated
   cache test also changes the same source path's mtime to cover external modification.
4. Alternate rapidly between two large documents. Confirm late requests never replace
   the active document and the network panel shows one in-flight request per resource.
5. With an existing cached preview, force Word conversion to fail in a development
   environment. Confirm the cached document stays visible, an error is shown, and Retry
   can refresh later. The automated test forces this exact failure deterministically.
6. Open a long document containing many images. Confirm text appears first, page images
   populate afterward, scrolling remains stable, and off-screen images load on approach.
7. Select and exit editable blocks repeatedly. Confirm the Quill chunk first downloads
   only on the first edit, the cursor/format controls work, and no duplicate listeners or
   editor instances appear.
8. Preview a change and double-click **Generate New Version**. Confirm only one job is
   accepted, the button remains disabled while pending, and only affected document rows
   refresh when it completes.
9. Verify generated text, bold/italic/underline, headings, lists, indentation, tables,
   images, headers/footers, download bundle, version history, and restore behaviour.
10. Simulate or inspect a failed generation and confirm no partial version row is current,
    staging files are cleaned, and retry starts from the saved request.

## Files changed

- `apps/api/app/database.py`
- `apps/api/app/document_service.py`
- `apps/api/app/editor_service.py`
- `apps/api/app/main.py`
- `apps/api/app/models.py`
- `apps/api/app/preview_cache_service.py` (new)
- `apps/api/app/preview_job_service.py`
- `apps/api/app/render_map_service.py`
- `apps/api/scripts/benchmark_document_opening.py` (new)
- `apps/api/scripts/benchmark_editor_generation.py` (new)
- `apps/api/tests/test_editor_workflow.py`
- `apps/api/tests/test_inline_preview_jobs.py`
- `apps/api/tests/test_workspace_migrations.py`
- `apps/desktop/tests/web-v140-contract.test.cjs`
- `apps/desktop/tests/web-v141-performance-contract.test.cjs`
- `apps/desktop/tests/web-v150-table-paragraph-contract.test.cjs`
- `apps/desktop/tests/web-v170-header-footer-contract.test.cjs`
- `apps/desktop/tests/web-v180-inline-layout-editing-contract.test.cjs`
- `apps/web/src/App.tsx`
- `apps/web/src/DocumentExperience.tsx`
- `apps/web/src/InlineLayoutEditor.tsx`
- `apps/web/src/WordPreviewOverlay.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/types.ts`
- `apps/web/src/workspaceResources.ts`
- `docs/performance-optimisation-2026-08.md` (new)

Deleted: `apps/web/src/QuillBlockEditor.tsx`.

Dependencies removed: none. Stored Delta compatibility and the reachable editor require
Quill; all declared frontend runtime dependencies remain in use.

## Remaining limitations

Cold Microsoft Word conversion is still bounded by Word startup, document complexity,
fonts, images, and COM automation and must remain serialized for reliability. The new
flow hides that latency behind readable cached/structured content but cannot eliminate
Word's own work. The 2.1 MB logo is still the largest initial asset, and Quill's lazy
chunk is sizeable when editing begins. PDF page generation and coordinate matching can
still take time on image-heavy documents, though neither blocks first text and both are
timed for further tuning.
