# Editable document editor

DocSync uses two complementary document surfaces:

- **Layout** renders the current immutable DOCX version through Microsoft Word when
  Word is available. It is read-only and remains the source of truth for pagination
  and unsupported Word objects.
- **Edit** exposes supported headings, paragraphs, list items, and top-level table
  cells as version-scoped structured blocks. One selected block is edited with the
  locally bundled Quill 2 editor.
- **Compare** reviews exact and near matches, highlights word-level differences,
  chooses target documents, and prepares a shared, per-document, or full-override
  operation.

The editor deliberately does not insert, delete, split, merge, or reorder Word
blocks. That boundary keeps every editable block mapped to one known DOCX location
and prevents unsupported content from being silently rewritten.

## Active-block undo and redo

The editor toolbar provides visible **Undo** and **Redo** buttons for the selected
block. `Ctrl+Z` undoes a draft change; `Ctrl+Y` or `Ctrl+Shift+Z` redoes it.
The macOS equivalents are `Command+Z` and `Command+Shift+Z`.

These controls operate only on the active block's uncommitted Quill history.
Opening another block or document version resets that history, and the controls
are disabled when their history stack is empty or the editor is read-only. Undo
and redo do not alter a generated version; use version restoration to return
committed document content to an earlier state.

## Version and block model

A `DocumentRecord` is the stable logical document. Its original upload is immutable.
Each file state is a `DocumentVersion` with a version number, checksum, parent
version, storage location, and optional generation/edit-operation link. A
`DocumentHead` identifies the current version and provides the optimistic
concurrency boundary for generation.

Every version owns immutable `DocumentBlockRevision` snapshots. A snapshot records:

- the version-scoped element ID and document order;
- element type, original and normalised text, and exact/structure hashes;
- Quill Delta and supported inline/paragraph formatting;
- list type and level;
- paragraph or table-cell write-back location;
- supported/read-only state and an actionable reason where applicable.

Generated versions receive new current element IDs. Historical snapshots retain
their original IDs for audit and download purposes.

## Version restoration

Any earlier version in a document's history can be restored without rewriting
history. DocSync copies the selected version's DOCX content into a staged,
validated `DocumentVersion` with a new ID and the next version number. The new
version becomes current only after the operation commits successfully.

The new version's parent is the version that was current immediately before the
restore. Its audit metadata separately records the selected source as
`restored_from_version_id` and `restored_from_version_number`. This preserves the
original upload, the restored-from version, the previously current version, and
every other historical version for lineage, audit, and download.

The restore request includes `expected_current_version_id`. If the document head
has changed since history was loaded, DocSync returns `409 Conflict` and creates no
file, version, operation, or head change. Restoring the already-current version
also returns `409 Conflict`, while selecting a version from another document
returns a validation error. A successful restore records an auditable
`version_restore` operation that links the restored-from source, previous current
version, and new result.

## Matching and comparison

Exact matching uses Unicode NFKC normalisation, case folding, trimming, and
whitespace collapsing. Element type is part of the exact-match identity.

Near matching is bounded and configurable. It combines text similarity with element
type, relative document position, and neighbouring-block context. Near matches are
never automatic edit targets. They must be explicitly confirmed and their decision
is persisted for the version-specific element pair.

Comparison returns token-level spans for shared, inserted, deleted, and changed
content. The interface renders labels as well as scores so the matching state does
not depend on colour alone.

Configuration:

```text
DOCUMENTSYNC_NEAR_MATCH_THRESHOLD
DOCUMENTSYNC_NEAR_MATCH_CANDIDATE_LIMIT
```

## Safe edit flow

1. Open the current document version and select a supported block.
2. Review exact and near matches.
3. Choose shared wording, per-document values, or a full paragraph override.
4. Select every intended target explicitly.
5. Preview the resulting text for every affected document. Preview is read-only and
   creates no file, version, or operation record.
6. Generate using the same base version IDs. If any document head changed after the
   preview, generation fails with `409 Conflict`.
7. DocSync writes staged DOCX files, validates them, records the operation and
   version lineage, advances document heads, refreshes current block mappings and
   exact groups, and commits the batch atomically.

The original upload is never overwritten. A failed generation rolls back database
state and removes staged output.

Restoration follows the same staged, validated, atomic-write boundary. It checks
the expected current version immediately before creating a new immutable
descendant, advances the document head only on success, and leaves every existing
version intact.

## Editor API

```text
GET  /api/document-versions/{version_id}/editor-content
GET  /api/document-elements/{element_id}/matches
GET  /api/document-elements/{element_id}/similar-matches
POST /api/document-elements/{element_id}/compare
POST /api/document-elements/{element_id}/match-decisions
POST /api/document-sets/{document_set_id}/editor-preview
POST /api/document-sets/{document_set_id}/editor-generate
GET  /api/documents/{document_id}/versions
POST /api/documents/{document_id}/versions/{target_version_id}/restore
GET  /api/document-versions/{version_id}/download
```

The original exact-match `/preview` and `/generate` endpoints remain available for
compatibility with existing clients and saved workspaces.

## Supported first-release content

Supported:

- normal body paragraphs and headings;
- ordered and unordered list items, including supported indentation levels;
- bold, italic, underline, alignment, and heading metadata represented in Delta;
- non-empty top-level table cells where a stable table/row/cell location exists.

Read-only or diagnostic-only:

- floating text boxes, shapes, SmartArt, and drawing objects;
- nested/merged table structures without a safe stable target;
- tracked changes, comments, footnotes, endnotes, fields, and complex
  cross-references;
- structural block insertion, deletion, split, merge, and reorder operations.

Unsupported content remains in the source DOCX and stays visible in Layout mode.

## Validation

From the repository root:

```powershell
python -m pytest apps/api
npm.cmd run build:web
npm.cmd test
```

Manual acceptance should cover exact shared wording, branch-specific values, list
preservation, a full override followed by another shared edit, unsupported Word
objects, active-block undo and redo, successful restoration with preserved
history, stale-current restoration conflict handling, and controlled generation
failure.
