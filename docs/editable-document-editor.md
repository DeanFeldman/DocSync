# Editable document editor

DocSync uses two complementary document surfaces:

- **Layout** renders the current immutable DOCX version through Microsoft Word when
  Word is available. It is read-only and remains the source of truth for pagination
  and unsupported Word objects.
- **Edit** exposes supported headings, body paragraphs, list items, individual
  paragraphs in supported top-level table cells, and safely mapped header and
  footer paragraphs as version-scoped structured blocks. One selected block is
  edited with the locally bundled Quill 2 editor.
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
- body, table/row/column/in-cell-paragraph, or section-aware header/footer
  write-back location;
- supported/read-only state and an actionable reason where applicable.

Generated versions receive new current element IDs. Historical snapshots retain
their original IDs for audit and download purposes.

## Header/footer paragraph mapping

The extractor walks default, first-page, and even-page headers and footers for
every Word section. It follows OOXML references without creating missing parts.
One mapped paragraph becomes `header_paragraph` or `footer_paragraph` and stores:

```json
{
  "kind": "header_paragraph",
  "section_index": 0,
  "source_section_index": 0,
  "header_footer_type": "default_header",
  "paragraph_index": 0,
  "part_relationship_id": "rId8",
  "document_order": 0,
  "is_linked_to_previous": true,
  "section_indexes": [0, 1],
  "linked_section_indexes": [1]
}
```

Sections inherited through Link to Previous resolve to the active relationship.
Blocks are deduplicated by physical relationship and paragraph. The writer
rebuilds the relationship map from the exact immutable source version and
validates region, type, source section, relationship, and paragraph index before
changing runs.

Header/footer paragraphs containing fields, drawings, embedded objects,
content controls, tracked changes, or comments remain visible and read-only.
Nested header/footer tables are excluded from editing. Sibling paragraphs,
fields, images, tables, settings, margins, distances, and link relationships
remain untouched.

## Table-paragraph mapping

Each non-empty direct paragraph in a supported top-level table cell is stored as
`element_type: table_paragraph`. Its immutable location contains:

```json
{
  "kind": "table_paragraph",
  "document_order": 4,
  "table_index": 0,
  "row_index": 2,
  "column_index": 1,
  "paragraph_index": 0
}
```

`document_order` keeps body paragraphs and tables in logical DOCX order. The
other indexes identify the exact physical paragraph for extraction, search,
preview, comparison, and write-back. Empty cell paragraphs are not presented as
editable blocks. Repeated XML cell references created by Word merges are
deduplicated by physical cell identity.

Generation resolves the mapped cell and then the mapped paragraph. It updates
only that paragraph's runs and supported paragraph properties. It does not set
`cell.text`, rebuild the table, or delete sibling paragraphs, so other cell
content and table OOXML remain present.

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
whitespace collapsing. Element type is part of the exact-match identity, so a
`table_paragraph` never automatically targets an unrelated body paragraph with
the same text.

For header/footer blocks, candidate identity also requires the same story type
and source-section context. Identical body text or an unrelated
first/even/default story cannot become an automatic target.

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
7. DocSync queues a durable background operation, writes staged DOCX files,
   validates them, records version lineage, advances document heads, refreshes
   affected block mappings and exact groups, and commits atomically. Navigation
   and unrelated drafts remain available.

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
POST /api/document-sets/{document_set_id}/editor-generate-async
GET  /api/editor-operations/{operation_id}
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
- non-empty paragraphs in top-level table cells where a stable
  table/row/column/paragraph location exists;
- ordered and unordered list metadata and supported indentation in those table
  paragraphs. Heading levels remain unavailable inside table cells;
- safely mapped default, first-page, and even-page header/footer paragraphs,
  including supported bold, italic, underline, alignment, indentation, and
  list formatting. Heading levels remain unavailable in these story blocks.

Read-only or diagnostic-only:

- floating text boxes, shapes, SmartArt, and drawing objects;
- nested or merged table structures without a safe stable target;
- cells containing drawings, fields, hyperlinks, tracked changes, comments, or
  other Word objects that cannot be rewritten safely;
- tracked changes, comments, footnotes, endnotes, fields, and complex
  cross-references;
- structural block insertion, deletion, split, merge, and reorder operations.

Unsupported content remains in the source DOCX and stays visible in Layout mode.

## v1.8 inline Layout editor

The Word-layout surface now uses controlled page images and normalized HTML
regions rather than a native PDF iframe. A reliable region selects the exact
versioned `element_id` while Layout stays active. All regions for that block are
highlighted and a single restricted Quill instance covers the clicked page
region. Its initial selection is estimated from clicked line and horizontal
position.

The inline instance consumes and publishes the same `QuillDraft` as structured
Edit. Formatting commands in the operation sidebar are sent to the active
instance; Quill then publishes the resulting Delta back to the shared draft.
Changing a block resets history, while Escape pauses inline typing and restores
focus to the selected region.

Structural safeguards remain identical to the structured editor: Enter is
rejected, multiline paste is flattened, unsupported attributes are sanitized
by the backend, and generation revalidates every element/version/head. The PDF
is explicitly a fixed snapshot. Longer drafts warn about possible wrapping,
and only a generated DOCX plus fresh Word render supplies authoritative final
pagination.

The Layout sidebar exposes source/version/location context, formatting,
Undo/Redo, exact targets, near-match score/differences/decisions, editing modes,
preview, and background generation. If coordinates are missing or uncertain,
**Select from structure** opens the established structured fallback instead of
guessing.

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
failure. The complete v1.5 table matrix is in
[`v1.5.0-manual-testing.md`](v1.5.0-manual-testing.md).
