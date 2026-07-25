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
objects, stale-version conflict handling, and controlled generation failure.
