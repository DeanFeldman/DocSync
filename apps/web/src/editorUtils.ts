import type {
  DifferenceKind,
  DifferenceSpan,
  DocumentSummary,
  DocumentView,
  EditorBlock,
  EditorContentResponse,
  EditorMatch,
  MatchDecision,
  QuillAttributes,
  QuillDelta,
  QuillOperation,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function normaliseListType(value: unknown): "ordered" | "bullet" | null {
  const lowered = String(value ?? "").toLocaleLowerCase();
  if (["ordered", "numbered", "number", "decimal"].includes(lowered)) {
    return "ordered";
  }
  if (["bullet", "bulleted", "unordered"].includes(lowered)) return "bullet";
  return null;
}

function blockAttributes(raw: UnknownRecord): QuillAttributes {
  const formatting = asRecord(raw.formatting);
  const list = asRecord(raw.list);
  const attributes: QuillAttributes = {};
  const elementType = firstString(raw.element_type, raw.type) ?? "paragraph";
  const listType = normaliseListType(
    raw.list_type ?? list.type ?? formatting.list_type,
  );
  const indent = firstNumber(
    raw.indent,
    raw.list_level,
    list.level,
    formatting.indent,
  );
  const alignment = firstString(
    raw.alignment,
    formatting.alignment,
    formatting.align,
  );
  const headingLevel = firstNumber(
    raw.heading_level,
    formatting.heading_level,
  );

  if (listType) attributes.list = listType;
  if (typeof indent === "number" && indent > 0) attributes.indent = indent;
  if (alignment && alignment !== "left") attributes.align = alignment;
  if (elementType === "heading") {
    attributes.header = Math.min(3, Math.max(1, headingLevel ?? 2));
  }
  return attributes;
}

export function textToDelta(
  text: string,
  attributes: QuillAttributes = {},
): QuillDelta {
  const ops: QuillOperation[] = [];
  if (text) ops.push({ insert: text });
  ops.push({
    insert: "\n",
    ...(Object.keys(attributes).length ? { attributes } : {}),
  });
  return { ops };
}

export function textFromDelta(delta: QuillDelta): string {
  return delta.ops
    .map((operation) =>
      typeof operation.insert === "string" ? operation.insert : "",
    )
    .join("")
    .replace(/\n$/, "");
}

function normaliseDelta(raw: UnknownRecord, text: string): QuillDelta {
  const delta = asRecord(raw.delta);
  if (Array.isArray(delta.ops)) {
    return {
      ops: delta.ops
        .map((operation) => asRecord(operation))
        .filter((operation) => Object.keys(operation).length > 0)
        .map((operation) => ({
          ...(typeof operation.insert === "string" ||
          (typeof operation.insert === "object" && operation.insert !== null)
            ? { insert: operation.insert as string | Record<string, unknown> }
            : {}),
          ...(typeof operation.retain === "number"
            ? { retain: operation.retain }
            : {}),
          ...(typeof operation.delete === "number"
            ? { delete: operation.delete }
            : {}),
          ...(typeof operation.attributes === "object" &&
          operation.attributes !== null
            ? { attributes: operation.attributes as QuillAttributes }
            : {}),
        })),
    };
  }
  return textToDelta(text, blockAttributes(raw));
}

function editorBlock(
  rawValue: unknown,
  index: number,
  document: DocumentSummary,
  responseVersionId: string,
): EditorBlock | null {
  const raw = asRecord(rawValue);
  const location = asRecord(raw.location);
  const formatting = asRecord(raw.formatting);
  const list = asRecord(raw.list);
  const elementId = firstString(raw.element_id, raw.id);
  if (!elementId) return null;

  const deltaRecord = asRecord(raw.delta);
  const fallbackDelta =
    Array.isArray(deltaRecord.ops)
      ? ({ ops: deltaRecord.ops as QuillOperation[] } satisfies QuillDelta)
      : null;
  const text =
    firstString(raw.text, raw.plain_text, raw.original_text) ??
    (fallbackDelta ? textFromDelta(fallbackDelta) : "");
  const elementType =
    firstString(raw.element_type, raw.type, raw.block_type) ?? "paragraph";
  const supportedDefault = [
    "paragraph",
    "heading",
    "list_item",
    "table_cell",
    "table_paragraph",
  ].includes(elementType);
  const editable = firstBoolean(raw.editable);
  const supported =
    firstBoolean(raw.supported, editable) ?? supportedDefault;
  const readOnly =
    firstBoolean(raw.read_only, raw.readonly) ??
    (!supported || editable === false);

  return {
    element_id: elementId,
    document_id:
      firstString(raw.document_id, location.document_id) ?? document.id,
    version_id:
      firstString(raw.version_id, location.version_id) ?? responseVersionId,
    element_type: elementType,
    paragraph_index:
      firstNumber(
        raw.paragraph_index,
        location.paragraph_index,
        location.block_index,
      ) ?? index,
    order:
      firstNumber(raw.order, raw.document_order, location.order) ?? index,
    page_number: firstNumber(raw.page_number, location.page_number),
    text,
    normalized_text: firstString(raw.normalized_text),
    exact_match_hash: firstString(raw.exact_match_hash, raw.match_hash),
    structure_hash: firstString(raw.structure_hash) ?? null,
    delta: normaliseDelta(raw, text),
    style_name: firstString(raw.style_name) ?? null,
    supported,
    read_only: readOnly,
    unsupported_reason:
      firstString(
        raw.unsupported_reason,
        raw.read_only_reason,
        raw.diagnostic,
      ) ?? null,
    list_type: normaliseListType(
      raw.list_type ?? list.type ?? formatting.list_type,
    ),
    indent:
      firstNumber(
        raw.indent,
        raw.list_level,
        list.level,
        formatting.indent,
      ) ?? 0,
    alignment:
      (firstString(
        raw.alignment,
        formatting.alignment,
        formatting.align,
      ) as EditorBlock["alignment"]) ?? null,
    table_index: firstNumber(raw.table_index, location.table_index),
    row_index: firstNumber(raw.row_index, location.row_index),
    column_index: firstNumber(raw.column_index, location.column_index),
    document_order: firstNumber(
      raw.document_order,
      location.document_order,
    ),
  };
}

export function normaliseEditorContent(
  value: unknown,
  document: DocumentSummary,
): EditorContentResponse {
  const raw = asRecord(value);
  const responseVersionId =
    firstString(raw.version_id, raw.current_version_id) ??
    document.current_version_id ??
    document.version_id;
  let rawBlocks: unknown[] = [];
  if (Array.isArray(raw.blocks)) rawBlocks = raw.blocks;
  else if (Array.isArray(raw.elements)) rawBlocks = raw.elements;
  else if (Array.isArray(raw.pages)) {
    rawBlocks = raw.pages.flatMap((page) => {
      const record = asRecord(page);
      return Array.isArray(record.elements) ? record.elements : [];
    });
  }

  const blocks = rawBlocks
    .map((block, index) =>
      editorBlock(block, index, document, responseVersionId),
    )
    .filter((block): block is EditorBlock => block !== null)
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.paragraph_index - right.paragraph_index,
    );
  const rawUnsupported = Array.isArray(raw.unsupported)
    ? raw.unsupported
    : Array.isArray(raw.diagnostics)
      ? raw.diagnostics
      : Array.isArray(raw.unsupported_elements)
        ? raw.unsupported_elements
        : [];
  const unsupported = rawUnsupported
    .map((value) => {
      const item = asRecord(value);
      const reason = firstString(
        item.reason,
        item.unsupported_reason,
        item.diagnostic,
        item.message,
      );
      if (!reason) return null;
      return {
        id: firstString(item.id, item.element_id),
        element_type:
          firstString(item.element_type, item.type, item.kind) ??
          "unsupported content",
        reason,
        location: firstString(item.location_label, item.location),
        text: firstString(item.text, item.preview),
      };
    })
    .filter(
      (
        diagnostic,
      ): diagnostic is {
        id: string | undefined;
        element_type: string;
        reason: string;
        location: string | undefined;
        text: string | undefined;
      } => diagnostic !== null,
    );

  return {
    document_id: firstString(raw.document_id) ?? document.id,
    version_id: responseVersionId,
    document_name: firstString(raw.document_name, raw.name) ?? document.name,
    version_number:
      firstNumber(raw.version_number, raw.current_version_number) ??
      document.version_number,
    created_at: firstString(raw.created_at, raw.version_created_at),
    blocks,
    unsupported_count:
      firstNumber(raw.unsupported_count) ??
      blocks.filter((block) => !block.supported || block.read_only).length +
        unsupported.length,
    unsupported,
    notice: firstString(raw.notice),
  };
}

export function editorContentFromView(
  view: DocumentView,
  document: DocumentSummary,
): EditorContentResponse {
  const blocks: EditorBlock[] = view.pages.flatMap((page) =>
    page.elements.map((element, index) => {
      const attributes: QuillAttributes = {};
      if (element.element_type === "heading") attributes.header = 2;
      if (element.element_type === "list_item") attributes.list = "bullet";
      return {
        element_id: element.id,
        document_id: element.document_id,
        version_id: view.version_id,
        element_type: element.element_type,
        paragraph_index: element.paragraph_index,
        order: page.page_number * 100_000 + index,
        page_number: page.page_number,
        text: element.text,
        delta: textToDelta(element.text, attributes),
        style_name: element.style_name,
        supported: true,
        read_only: false,
        list_type: element.element_type === "list_item" ? "bullet" : null,
        indent: 0,
        alignment: null,
        table_index: element.table_index,
        row_index: element.row_index,
        column_index: element.column_index,
      };
    }),
  );
  return {
    document_id: view.document_id,
    version_id: view.version_id,
    document_name: view.document_name,
    blocks,
    unsupported_count: 0,
    unsupported: [],
    notice:
      "Compatibility editor content. Rich Word formatting metadata is not available from this local service version.",
  };
}

function tokenise(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_'\u2019-]+|[^\s]/gu) ?? [];
}

function appendSpan(
  spans: DifferenceSpan[],
  text: string,
  kind: DifferenceKind,
) {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else spans.push({ text, kind });
}

export function wordDifferenceSpans(
  source: string,
  candidate: string,
): DifferenceSpan[] {
  if (source === candidate) return [{ text: candidate, kind: "shared" }];
  const left = tokenise(source);
  const right = tokenise(candidate);
  if (left.length > 260 || right.length > 260) {
    return [{ text: candidate, kind: "different" }];
  }

  const rows = Array.from({ length: left.length + 1 }, () =>
    new Uint16Array(right.length + 1),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (
      let rightIndex = right.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      rows[leftIndex][rightIndex] =
        left[leftIndex].toLocaleLowerCase() ===
        right[rightIndex].toLocaleLowerCase()
          ? rows[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              rows[leftIndex + 1][rightIndex],
              rows[leftIndex][rightIndex + 1],
            );
    }
  }

  const spans: DifferenceSpan[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (rightIndex < right.length) {
    if (
      leftIndex < left.length &&
      left[leftIndex].toLocaleLowerCase() ===
        right[rightIndex].toLocaleLowerCase()
    ) {
      appendSpan(spans, right[rightIndex], "shared");
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      leftIndex < left.length &&
      rows[leftIndex + 1][rightIndex] > rows[leftIndex][rightIndex + 1]
    ) {
      leftIndex += 1;
    } else {
      appendSpan(spans, right[rightIndex], "different");
      rightIndex += 1;
    }
  }
  return spans.length ? spans : [{ text: candidate, kind: "different" }];
}

function normaliseDecision(value: unknown): MatchDecision {
  const decision = String(value ?? "").toLocaleLowerCase();
  if (["confirmed", "confirm", "included", "accepted"].includes(decision)) {
    return "confirmed";
  }
  if (["ignored", "ignore"].includes(decision)) return "ignored";
  if (["removed", "remove", "rejected"].includes(decision)) return "removed";
  return "pending";
}

function normaliseDifferenceSpans(
  value: unknown,
  sourceText: string,
  candidateText: string,
): DifferenceSpan[] {
  if (!Array.isArray(value)) return wordDifferenceSpans(sourceText, candidateText);
  const spans: Array<DifferenceSpan | null> = value
    .map((item): DifferenceSpan | null => {
      const raw = asRecord(item);
      const text = firstString(raw.text, raw.value, raw.content);
      if (!text) return null;
      const rawKind = String(
        raw.kind ?? raw.type ?? raw.status ?? "different",
      ).toLocaleLowerCase();
      const kind: DifferenceKind = [
        "equal",
        "shared",
        "unchanged",
      ].includes(rawKind)
        ? "shared"
        : ["insert", "added"].includes(rawKind)
          ? "insert"
          : ["delete", "removed"].includes(rawKind)
            ? "delete"
            : "different";
      return { text, kind };
    })
    .filter((span): span is DifferenceSpan => span !== null);
  const filtered = spans.filter(
    (span): span is DifferenceSpan => span !== null,
  );
  return filtered.length
    ? filtered
    : wordDifferenceSpans(sourceText, candidateText);
}

export function normaliseMatch(
  value: unknown,
  sourceText: string,
  fallbackMatchType: "exact" | "near",
): EditorMatch | null {
  const raw = asRecord(value);
  const location = asRecord(raw.location);
  const elementId = firstString(raw.element_id, raw.id, raw.candidate_element_id);
  const documentId = firstString(raw.document_id, location.document_id);
  if (!elementId || !documentId) return null;
  const text = firstString(raw.text, raw.candidate_text) ?? "";
  let score =
    firstNumber(raw.similarity_score, raw.score) ??
    (fallbackMatchType === "exact" ? 1 : 0);
  if (score > 1) score /= 100;
  score = Math.max(0, Math.min(1, score));
  const matchType =
    String(raw.match_type ?? fallbackMatchType).toLocaleLowerCase() === "exact"
      ? "exact"
      : "near";
  const decision =
    matchType === "exact"
      ? "confirmed"
      : normaliseDecision(raw.decision ?? raw.confirmation_status);
  const rawSpans =
    raw.difference_spans ?? raw.diff_spans ?? raw.spans ?? raw.differences;

  return {
    element_id: elementId,
    document_id: documentId,
    document_name:
      firstString(raw.document_name, raw.name) ?? "Related document",
    version_id: firstString(raw.version_id),
    paragraph_index:
      firstNumber(raw.paragraph_index, location.paragraph_index) ?? 0,
    element_type:
      firstString(raw.element_type, raw.type) ?? "paragraph",
    text,
    style_name: firstString(raw.style_name) ?? null,
    match_type: matchType,
    similarity_score: score,
    decision,
    difference_spans: normaliseDifferenceSpans(
      rawSpans,
      sourceText,
      text,
    ),
    table_index: firstNumber(raw.table_index, location.table_index),
    row_index: firstNumber(raw.row_index, location.row_index),
    column_index: firstNumber(raw.column_index, location.column_index),
    document_order: firstNumber(
      raw.document_order,
      location.document_order,
    ),
  };
}

export function candidateArrays(value: unknown): unknown[] {
  const raw = asRecord(value);
  for (const key of ["items", "matches", "similar_matches", "comparisons"]) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return [];
}
