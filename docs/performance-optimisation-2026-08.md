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

---

# Deep performance follow-up — 24 August 2026

## Scope and baseline method

This follow-up targeted the remaining measured bottlenecks rather than changing
DOCX parsing or the already-fast cached structured response. The required tests,
web build, and three existing benchmarks were run before implementation on the
same Windows/Python installation used for the post-change measurements.

The pre-change measurements in this worktree were:

| Benchmark | Pre-change result |
| --- | ---: |
| 10 documents × 500 blocks workspace median | 5,777.51 ms |
| Workspace p95 | 6,021.07 ms |
| Workspace persistence median | 3,316.86 ms |
| Workspace exact-match median | 1,547.49 ms |
| 3 documents × 300 blocks generation median | 1,111.95 ms |
| 1,000-block cached structured opening median | 36.50 ms |
| Production logo asset | 2,107.10 kB |

The older v1.4.1 report remains historical evidence; its 3.19 second workspace
median was produced on a different run state and is not substituted for this
turn's before/after comparison.

## Persistent Microsoft Word worker

The old renderer launched `powershell.exe`, created `Word.Application`, rendered
one document, called `Quit`, and exited for every cache miss. The new
`word_render_service.py` owns one long-lived PowerShell JSON-lines worker. The
worker creates one invisible Word COM application, disables alerts, macros, and
link updates, opens each DOCX read-only, exports one temporary PDF, closes the
document, and keeps Word available for the next serial request.

The worker recycles Word after `DOCUMENTSYNC_WORD_WORKER_MAX_RENDERS` (25 by
default), restarts the complete worker once after COM/process failure, detects an
unexpected child exit immediately, and shuts down through the FastAPI lifespan.
The PowerShell worker records its owned WINWORD process and force-stops only that
PID if `Word.Quit()` does not complete, including when the backend disappears and
stdin closes. A forced-backend-stop verification confirmed the owned Word PID was
removed. The final PDF is still published only by temporary-file atomic replace;
a failed refresh cannot overwrite the previous valid PDF.

Final local sequential-render measurement:

| Measurement | Result |
| --- | ---: |
| Worker/Word startup | 1,808.87 ms |
| First uncached render | 49,808.44 ms |
| Cold first render including startup | 51,617.31 ms |
| Second uncached render | 251.19 ms |
| Third uncached render | 236.89 ms |
| Warm worker median | 244.04 ms |

There was no equivalent pre-change sequential-worker benchmark, so no percentage
claim is made. The unusually high first export is specific to this Microsoft Word
installation; the meaningful observation is that the same PowerShell/Word worker
PID served all three renders and the warm jobs did not repeat that startup/export
penalty.

## Lazy PDF page rendering and preview state

Render-map schema 2 separates `_extract_pdf_structure` from `_render_pdf_page`.
The initial worker validates the immutable PDF, extracts page dimensions and word
coordinates, performs the unchanged contextual matching, and publishes page URLs
without rasterising the full PDF. The first two pages are queued for background
prefetch. Any page endpoint request checks the immutable render ID, page bounds,
PDF size/mtime, source checksum, engine, PyMuPDF version, and DPI, then renders
only the missing page under a striped per-page lock and atomically caches it.

The preview job now waits on the render-map worker's completion event. It no
longer polls every 80 ms or commits an unchanged map status repeatedly. The map
remains file-backed and a restarted application can resubmit any nonterminal map,
so durable recovery semantics are unchanged.

The new 40-page synthetic benchmark measured:

| Stage | Result |
| --- | ---: |
| Text/coordinate extraction | 31.94 ms |
| Block matching | 1.16 ms |
| First-page rasterisation | 24.05 ms |
| Explicit full-document rasterisation | 984.28 ms |
| Initial PNG count before a page request | 0 |

The pre-change pipeline did not have a stage-separated benchmark. The architectural
result is directly verified: the initial text/map path produced zero PNGs, while
all 40 appeared only when the benchmark explicitly requested full rasterisation.

## Bulk persistence and SQL exact matching

Initial workspace creation now prepares immutable element/version/head/revision
mappings and executes batched SQLAlchemy Core inserts. It avoids tracking thousands
of equivalent `DocumentElement` and `DocumentBlockRevision` ORM instances while
preserving preassigned UUIDs, JSON formatting/Delta/location metadata, lineage,
hashes, order, transaction rollback, and file cleanup. The optimisation is isolated
to initial import and add-document creation; editing/generation retains its ORM and
versioning behaviour.

Exact matching now asks SQLite to group current, shared, supported revisions by
their indexed exact hash and retain only hashes with at least two distinct document
IDs. Only those candidate members are returned to Python, and link groups/members
are inserted in batches. Incremental hash rebuilds remain in place.

| Workspace measurement | Before | After | Absolute change | Change |
| --- | ---: | ---: | ---: | ---: |
| HTTP median | 5,777.51 ms | 1,360.00 ms | −4,417.51 ms | 76.46% lower |
| p95 | 6,021.07 ms | 1,530.22 ms | −4,490.85 ms | 74.58% lower |
| Persistence median | 3,316.86 ms | 1,015.22 ms | −2,301.64 ms | 69.39% lower |
| Exact-match median | 1,547.49 ms | 121.46 ms | −1,426.03 ms | 92.15% lower |

The 1.36 second median meets the 2.0 second target and 1.5 second stretch goal on
this machine. A forced post-insert failure test verifies that both database rows
and newly written workspace files roll back.

## SQLite FTS5

Schema migration 7 creates `document_block_fts` with the SQLite FTS5 trigram
tokenizer. Insert/update/delete triggers transactionally index every immutable
block revision; the existing `document_heads` join selects only current versions,
so generation and restore need no separate manual refresh path. Document removal
cannot return stale hits because candidates still join live revisions/documents.

FTS identifies candidate revisions; the existing Unicode-normalised occurrence
scanner still calculates exact source offsets, context, matched text, result counts,
and document counts. Queries shorter than three characters, non-SQLite databases,
and SQLite builds without FTS5/trigram safely use the prior escaped substring path.

For 50 documents × 1,000 blocks (50,000 revisions, five runs):

| Candidate retrieval | Median |
| --- | ---: |
| Previous substring scan | 20.93 ms |
| FTS5 trigram | 7.46 ms |
| Absolute change | −13.47 ms |
| Change | 64.36% lower |

End-to-end FTS search, including exact occurrences and response construction for
500 results, was 23.78 ms median.

## Frontend asset and startup

The logo was resized from 1,536 × 1,024 to 384 × 256 using high-quality Lanczos
resampling and lossless PNG optimisation. Its source/bundle size fell from
2,107.10 kB to 21.42 kB (2,085.68 kB and 98.98% lower) without changing the
design or file format. The production application and lazy Quill JavaScript chunks
remain 293.21 kB and 200.03 kB respectively.

The root `prestart` production build was removed. `npm start` now launches the
already-built application; production assets are built explicitly through
`build:web`/`build:desktop`. `npm run dev` starts FastAPI on port 8001, Vite with
hot reload on port 5173, and an Electron shell pointed at the live frontend. Its
default data directory is isolated under ignored `.artifacts/dev-workspace`; an
explicit `DOCUMENTSYNC_DATA_DIR` still wins.

## Regression measurements and limitations

The post-change generation median was 578.29 ms (baseline 1,111.95 ms), and the
cached structured-opening median was 26.50 ms (baseline 36.50 ms). These were
regression guards, not targeted optimisations, so the lower values may include
filesystem/OS cache variance and are not attributed to a particular code change.

Microsoft Word remains serial by design and its first export can still dominate an
uncached preview. Page rasterisation remains proportional to requested pages and
image/DPI complexity. Initial import still spends about one second preparing rich
revision metadata and writing the FTS-triggered rows. Search response construction
still scales with the number of exact occurrences returned even though candidate
retrieval is indexed.

The live development frontend, direct API, Vite-proxied API, Electron processes,
and served 21,429-byte logo were verified. Full click-through of the 20-item manual
UI checklist was not automated in this environment because the in-app browser
automation surface was unavailable; API/workflow tests cover upload, search,
editing, generation, restore, preview retry, stale cache, headers/footers, tables,
formatting, and rollback.
