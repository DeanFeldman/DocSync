# Phase 2 architecture

```mermaid
flowchart LR
    U[Document editor] --> W[React web client]
    W -->|multipart and JSON over HTTP| A[FastAPI backend]
    A --> V[Validation and authorisation boundary]
    V --> P[DOCX parser and edit engine]
    V --> R[Microsoft Word PDF renderer]
    V --> D[(Relational database)]
    V --> S[(Private file storage)]
    P --> S
    A --> W
```

## Trust boundary

The browser never receives database credentials or storage credentials. All document access, matching, preview, generation, and download decisions pass through the backend.

## Local-development storage

- Original files: `apps/api/data/originals/{document-set-id}/`
- Generated files: `apps/api/data/generated/{document-set-id}/{generation-id}/`
- Cached Word-layout PDFs: `apps/api/data/renders/{document-set-id}/`
- Local database: `apps/api/data/documentsync.db`

The paths are excluded from Git. Production deployment should replace local storage with private object storage and use short-lived or backend-mediated downloads.

## Relational model

```mermaid
erDiagram
    DOCUMENT_SET ||--o{ DOCUMENT : contains
    DOCUMENT ||--o{ DOCUMENT_ELEMENT : contains
    DOCUMENT_SET ||--o{ LINK_GROUP : proposes
    LINK_GROUP ||--o{ LINK_MEMBER : contains
    DOCUMENT_ELEMENT ||--o{ LINK_MEMBER : joins
    DOCUMENT_SET ||--o{ GENERATION_JOB : produces
    GENERATION_JOB ||--o{ GENERATED_VERSION : contains
    GENERATION_JOB ||--o{ GENERATION_TARGET : audits
```

## Controlled edit rule

A generated edit may only target `DocumentElement` rows that belong to the selected `LinkGroup`. The browser sends the explicitly included element IDs and the backend validates membership and requires the selected source element to remain included. Similarity or exact matching alone does not perform an edit; the user confirms the target list and reviews the impact before generation.

## Viewer and working-version boundary

The visual tab is a PDF exported by the installed Microsoft Word engine, so it uses Word's fonts, pagination, tables, images, headers, and footers. The separate Select text tab derives deterministic logical pages from extracted body elements and provides stable, keyboard-accessible element selection. Direct selection over the PDF awaits an element-to-render coordinate map.

Each `DocumentRecord` is a stable logical document. Its uploaded DOCX remains immutable. A confirmed edit creates a `GeneratedVersion`; the newest completed version becomes that document's current source for rendering, further edits, and downloads. The element rows and exact-match groups are refreshed transactionally after each applied edit, while `GenerationTarget` rows preserve the before/after audit trail.

## v1.5 table-paragraph boundary

The extractor walks direct document-body children so normal paragraphs and
top-level tables retain logical order. Each physical table cell is visited once,
then each non-empty direct paragraph becomes an immutable `table_paragraph`
block with table, row, column, paragraph, and document-order metadata.

The writer resolves that full location against the same immutable DOCX version
and mutates only the selected paragraph's runs and supported paragraph
properties. It never rebuilds the table or assigns `cell.text`. Merged cells,
nested tables, and cells with unsupported Word objects are classified read-only
before preview and checked again during write-back.

Schema migration 2 reparses every stored version to create the same mapping for
pre-v1.5 workspaces. The existing migration coordinator verifies a database
backup first and restores it if any stored version cannot be regenerated.
