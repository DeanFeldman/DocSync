# Batch editing and complete Word text inventory

## Product invariant

DocSync treats discovery and editability as separate concerns. Text that is
found in a protected structure remains a search result with an explicit reason;
it is never removed from the count merely because write-back is unsafe.

Find & Replace follows a review-first workflow:

1. scan current immutable document versions;
2. review every occurrence and its editability;
3. select occurrences and add an operation to durable pending changes;
4. optionally add reviewed rich-editor operations to the same batch;
5. preview the compiled batch and resolve conflicts;
6. generate at most one new version per affected document.

## Text discovery

`DocumentTextInventory` reads the original OPC/OOXML ZIP package directly. A
`DocumentTextSegment` represents one logical text stream and records:

- document and immutable version identity;
- XML part and a stable element-index path;
- Word structure and human-readable location metadata;
- logical and NFKC-normalized text;
- character ranges mapped to individual OOXML text nodes;
- editable and protected ranges with specific reasons.

Physical header/footer parts are resolved from section relationships and
deduplicated. A linked-to-previous header referenced by several sections is one
search occurrence, not one occurrence per section reference.

Visible `w:t` values are concatenated at paragraph scope, including values split
by run formatting, bookmarks, hyperlinks, content controls, and tracked
insertions. Nested paragraphs and text-box paragraphs use their own nearest
paragraph, avoiding duplicate discovery. Field instructions and tracked
deletions are separate, opt-in logical streams. DrawingML `a:t` is a separate
read-only stream.

Search normalization uses NFKC plus Unicode case folding and whitespace
collapse. Every normalized character retains its original start/end offsets,
so length-changing cases such as `Straße`/`STRASSE` still return correct OOXML
ranges. Whole-word matching treats letters, digits, underscore, and combining
marks as word characters. Apostrophes and hyphens are boundaries: `company`
matches `company's`, `pre-company`, and `company-wide`, but not `companies`.

FTS5 trigram search remains a candidate-order accelerator. It never excludes a
document from the authoritative inventory scan. One-character and punctuation
queries bypass FTS when it cannot safely represent them.

## Logical offsets and cross-run replacement

Each `TextNodeSpan` maps a logical `[start, end)` range to an XML node path and
records whether that range is ordinary text, hyperlink display text, a field
result, tracked text, or another role. Replacement compilation validates the
immutable source text, occurrence identity, range editability, duplicates, and
overlaps before creating node-local edits.

Node edits are applied from the highest offset to the lowest offset. A
replacement spanning several runs is inserted into the first matched text node;
the matched slices in later nodes are removed. Therefore the replacement
inherits the formatting of the first matched character/run. Unaffected text and
its run formatting are untouched. Hyperlink relationship IDs and destinations
remain intact. Rich editor operations continue to use their supplied Quill
Delta formatting.

Only changed XML parts are serialized back into the original ZIP. Untouched
styles, numbering, relationships, media, custom XML, metadata, and embedded
parts are copied byte-for-byte.

## Protected ranges

A segment can contain both editable and protected spans. Ordinary text before
or after a hyperlink or field remains editable. A match that crosses a protected
field, tab/line-break/symbol, hyperlink boundary, content-control boundary, or
revision boundary is rejected with a specific reason. This avoids making a
whole mixed-content paragraph read-only.

## Durable batch model

The existing `EditorOperation` is the durable batch/background-job and version
lineage envelope (`operation_type = batch`). Additive schema migration 8 adds:

- `EditBatchOperation`: ordered Find & Replace or rich-editor operations;
- `EditBatchOccurrence`: immutable version, segment, range, expected text,
  location, selection state, and resulting-version audit data.

Drafts survive restart. Every affected document is pinned to the current
`DocumentVersion`. Generation refuses a stale head or changed expected text.
The compiled plan classifies duplicate occurrences, overlapping ranges,
duplicate editor targets, editor/substring collisions, stale versions, invalid
locations, and read-only ranges before file writes.

Generation groups all enabled operations by document. It opens/serializes the
document once, applies all rich editor changes, then locally patches all safe
substring ranges. All documents are staged and validated before the staging
directory is promoted. New `DocumentVersion`, block revision, operation audit,
occurrence result, and `DocumentHead` rows are committed in one database
transaction. Failure removes staging/final output and leaves every head on its
previous version.

## Support matrix

| Word structure | Search | Replace | Actual behavior |
| --- | --- | --- | --- |
| Body paragraph, heading, list | Yes | Yes | Logical substring and rich editor |
| Mixed runs/bookmarks | Yes | Yes | Cross-run; first matched run supplies replacement formatting |
| Hyperlink display text | Yes | Yes | Relationship and URL preserved; boundary-crossing matches blocked |
| Top-level and nested tables | Yes | Yes | Every cell paragraph is a distinct logical segment |
| Headers/footers | Yes | Yes | Default/first/even; linked physical parts deduplicated |
| Footnotes/endnotes | Yes | Yes | Normal `w:t` ranges patched locally |
| Content controls | Yes | Yes, partial | Text wholly inside a control is editable; cross-boundary ranges blocked |
| WML/VML text boxes | Yes | Yes | `w:txbxContent` paragraphs use stable node paths |
| Comments | Yes, opt-in | Yes | Independent `comments.xml` text; excluded from default search |
| Field result | Yes | No by default | Displayed result is protected to avoid invalid field behavior |
| Field instruction | Yes, opt-in | No | Separate protected stream |
| Surrounding text in field paragraph | Yes | Yes | Ranges not touching the field remain editable |
| Tracked insertion | Yes | Yes, partial | Text wholly inside the insertion can change; revision markup preserved |
| Tracked deletion | Yes, opt-in | No | Historical protected stream |
| DrawingML `a:t` shape text | Yes | No | Reported read-only with a DrawingML reason |
| Tabs, line breaks, symbols | Yes | No across atom | The character is mapped but protected |

## API

- `POST /api/document-sets/{id}/find-replace/search`
- `POST /api/document-sets/{id}/edit-batches`
- `GET /api/document-sets/{id}/edit-batches/draft`
- `GET /api/edit-batches/{id}`
- `POST /api/edit-batches/{id}/operations`
- `PUT /api/edit-batches/{id}/operations/{operation_id}`
- `PATCH /api/edit-batches/{id}/occurrences/{occurrence_id}`
- `DELETE /api/edit-batches/{id}/operations/{operation_id}`
- `DELETE /api/edit-batches/{id}`
- `POST /api/edit-batches/{id}/preview`
- `POST /api/edit-batches/{id}/generate`

The existing editor-operation status, download, generation history, immutable
version, preview, and restore endpoints continue to apply to completed batches.

## Known boundaries

Chart labels/values, equation text, embedded OLE content, external linked
documents, and vendor-specific/custom XML text are not currently promoted to
user-visible inventory segments. DrawingML shape text is discovered but remains
read-only. Field results/instructions and tracked deletions remain protected.
These boundaries must remain explicit in release/manual testing; they must not
be represented as editable support.
