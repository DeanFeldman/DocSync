# DocumentSync HTTP API

Base path: `/api`

## `GET /health`

Returns API status.

```json
{
  "status": "ok"
}
```

## Header/footer block shape

Header and footer content is returned one mapped physical paragraph at a time.
Linked sections using the same physical part are deduplicated. Example:

```json
{
  "element_type": "header_paragraph",
  "kind": "header_paragraph",
  "section_index": 0,
  "source_section_index": 0,
  "header_footer_type": "default_header",
  "paragraph_index": 0,
  "part_relationship_id": "rId8",
  "is_linked_to_previous": true,
  "section_indexes": [0, 1],
  "linked_section_indexes": [1],
  "supported": true,
  "read_only": false,
  "unsupported_reason": null
}
```

## `POST /document-sets`

Creates a document set from multipart form data.

Fields:

- `name`: document-set name.
- `files`: two or more DOCX files.

Response includes uploaded documents and exact-match link groups.

## `GET /document-sets/{document_set_id}`

Returns the current document set, its documents, extracted-element counts, and exact-match link groups.

Each document includes a `version_id` and `view_url` for the immutable uploaded version.

## Preview-render endpoints

```text
POST /document-versions/{version_id}/preview-jobs
GET  /preview-jobs/{job_id}
GET  /document-versions/{version_id}/preview
GET  /document-versions/{version_id}/rendered-file
GET  /document-versions/{version_id}/render-map
GET  /document-versions/{version_id}/render-pages/{render_id}/{page_number}.png
```
Exports the current immutable DOCX version to a cached PDF through Microsoft
Word, queues coordinate extraction, and returns the PDF URL, render-map status
and URL, and structured element payload. PDF viewing does not wait for the map.

The POST returns `202 Accepted` before Word conversion. A representative job is:

```json
{
  "job_id": "uuid",
  "document_id": "uuid",
  "version_id": "uuid",
  "status": "processing",
  "stage": "rendering_pdf",
  "pdf_ready": false,
  "render_map_ready": false,
  "render_map_status": "not_requested",
  "cache_hit": false,
  "error": null
}
```

Stages are `queued`, `starting_microsoft_word`, `opening_document`,
`rendering_pdf`, `displaying_document`, `preparing_selectable_text`,
`ready_to_edit`, and `failed`. `pdf_ready` permits the client to fetch the
preview immediately; it must not wait for `render_map_ready`.

The render map reports normalized page regions with render/version/element
identity, type, text preview, location, confidence, mapping method,
`interactive`, `read_only`, and reason fields. During `processing`, `pages` may
already contain controlled PNG URLs while `regions` is still empty. Completed
and partial maps may contain both interactive and explained read-only regions.

`GET rendered-file` never starts Word. It returns the cached immutable PDF only
after a background job has created it. The legacy synchronous render endpoint
is retained for compatibility, but v1.8 Layout uses preview jobs.

## `POST /documents/{document_id}/render` (compatibility)

Exports the current working DOCX version to a cached PDF through Microsoft Word and returns both the PDF URL and the structured element payload. Applying an edit invalidates the affected PDF cache before the browser refreshes it.

## `GET /document-versions/{version_id}/render-map`

Returns the version/render-bound coordinate map. Status is one of
`not_requested`, `queued`, `processing`, `completed`, `partial`, or `failed`.
Queued and processing responses should be polled with bounded backoff.

Example terminal response (abridged):

```json
{
  "schema_version": 1,
  "version_id": "version-456",
  "document_id": "document-123",
  "document_set_id": "workspace-789",
  "status": "completed",
  "coordinate_unit": "normalised",
  "render_id": "4d92381ce36b19c4eabc1234",
  "render_version": "4d92381ce36b19c4eabc1234",
  "source_sha256": "...",
  "pdf_sha256": "...",
  "pdf_engine": "Microsoft Word ExportAsFixedFormat PDF",
  "mapper": "PyMuPDF",
  "mapper_version": "1.28.0",
  "interactive_threshold": 0.9,
  "page_count": 1,
  "pages": [
    {
      "page_id": "4d92381ce36b19c4eabc1234:1",
      "page_number": 1,
      "page_width": 612.0,
      "page_height": 792.0,
      "coordinate_unit": "normalised",
      "render_version": "4d92381ce36b19c4eabc1234",
      "image_url": "/api/document-versions/version-456/render-pages/4d92381ce36b19c4eabc1234/1.png"
    }
  ],
  "regions": [
    {
      "region_id": "element-123:1:1",
      "element_id": "element-123",
      "version_id": "version-456",
      "element_type": "paragraph",
      "page_number": 1,
      "x": 0.1421569,
      "y": 0.3180521,
      "width": 0.6110049,
      "height": 0.0471221,
      "confidence": 0.99,
      "mapping_method": "word_pdf_text_context_order",
      "interactive": true,
      "read_only": false,
      "reason": null
    }
  ],
  "unmapped": []
}
```

A `partial` result keeps reliable regions selectable and lists unresolved
blocks in `unmapped`. A `failed` result has no clickable regions and does not
affect the successful PDF. Maps are disposable cache data, not document state.

## `GET /document-versions/{version_id}/render-pages/{render_id}/{page}.png`

Returns one controlled page image only when the immutable version, current map,
render ID, and page number all match. Mismatched or stale paths return `404`.

## `GET /document-versions/{version_id}/pages`

Returns render status, the pagination mode, the support notice, and logical pages containing selectable elements with stable IDs, types, styles, and paragraph locations.

Table content is returned one non-empty paragraph at a time. A supported block
uses `element_type: "table_paragraph"` and includes:

```json
{
  "document_order": 4,
  "table_index": 0,
  "row_index": 2,
  "column_index": 1,
  "paragraph_index": 0,
  "supported": true,
  "read_only": false,
  "unsupported_reason": null
}
```

## Structured editor endpoints

```text
GET  /document-versions/{version_id}/editor-content
GET  /document-elements/{element_id}/matches
GET  /document-elements/{element_id}/similar-matches
POST /document-elements/{element_id}/compare
POST /document-elements/{element_id}/match-decisions
POST /document-sets/{document_set_id}/editor-preview
POST /document-sets/{document_set_id}/editor-generate
POST /document-sets/{document_set_id}/editor-generate-async
GET  /editor-operations/{operation_id}
GET  /generation-jobs/{job_id}
GET  /document-sets/{document_set_id}/generation-jobs
POST /generation-jobs/{job_id}/retry
```

Editor preview/generation requests provide a current immutable version for every
target document in `base_versions`. A stale head returns `409 Conflict` before
any version is saved. `targets` may carry one replacement/Delta per document.
Table-paragraph preview changes include the exact table location. Header/footer
changes include section, part type, paragraph, relationship, and linked
sections. Preview resolves the source version and performs the DOCX round-trip
in memory without writing a file or database row.

The asynchronous generation endpoint returns `202 Accepted` with an operation
ID, status URL, stage, and affected-document summary. Poll the operation or job
endpoint until `completed`, `failed`, or `interrupted`. Stages are `queued`,
`preparing_documents`, `applying_changes`, `validating_files`,
`saving_versions`, `refreshing_workspace`, and a terminal status. A retry
creates a new operation from the stored reviewed request.

## `GET /documents/{document_id}/download`

Downloads the current working DOCX for one logical document. Before any edit this is the immutable upload; after edits it is the latest applied generated version.

## `GET /document-elements/{element_id}/matches`

Returns the selected source element and its exact-match link group. Similar matches are deliberately reported as not enabled and are never inferred as confirmed targets.

## `POST /document-sets/{document_set_id}/preview`

Request:

```json
{
  "link_group_id": "uuid",
  "source_element_id": "uuid",
  "included_element_ids": ["source-uuid", "confirmed-target-uuid"],
  "replacement_text": "The revised paragraph"
}
```

Response lists each affected document and element location. No file is changed or generated by this endpoint. Included IDs must belong to the link group, and the source must remain included. The two new fields are optional for compatibility with the Phase 1 client; omitting them selects the whole exact-match group.

## `POST /document-sets/{document_set_id}/generate`

Uses the same request body as preview. It creates new DOCX versions, makes them the active workspace sources, rebuilds exact-match groups from the updated text, and returns the refreshed document set. Original uploads are never overwritten. The ZIP is a snapshot of every current document, including unchanged documents and changes applied by earlier generations.

Response:

```json
{
  "generation_id": "uuid",
  "status": "completed",
  "files": [
    {
      "source_document_id": "uuid",
      "name": "Building-A-Agreement-updated.docx"
    }
  ],
  "download_url": "/api/generations/uuid/download",
  "document_set": {}
}
```

## `GET /generations/{generation_id}/download`

Downloads the generated ZIP archive.

## `GET /document-sets/{document_set_id}/history`

Returns synchronised-edit audit events, generated-version counts, and the exact before/after target locations recorded for each generation.

## Error format

FastAPI validation errors use the framework's standard `detail` structure. Application errors use:

```json
{
  "detail": "Human-readable error message"
}
```
