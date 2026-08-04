import {
  KeyboardEvent,
  MouseEvent,
  RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { absoluteApiUrl, fetchRenderMap } from "./api";
import InlineLayoutEditor, {
  type InlineEditorCommand,
} from "./InlineLayoutEditor";
import type { QuillDraft } from "./QuillBlockEditor";
import type {
  EditorBlock,
import type {
  RenderMapPage,
  RenderMapRegion,
  RenderMapResponse,
} from "./types";

type ScaleMode = "custom" | "fit-width" | "fit-page";

export interface LayoutSelectionIntent {
  elementId: string;
  versionId: string;
  regionId: string;
  pageNumber: number;
  caretFraction: number;
  keyboard: boolean;
  requestId: number;
}

type ScaleMode = "custom" | "fit-width" | "fit-page";

interface WordPreviewOverlayProps {
  documentName: string;
  versionId: string;
  selectedElementId: string;
  selectedBlock: EditorBlock | null;
  draft: QuillDraft | null;
  editorResetToken: number;
  inlineSelection: LayoutSelectionIntent | null;
  inlineCommand: InlineEditorCommand | null;
  editorDisabled: boolean;
  onSelect: (intent: LayoutSelectionIntent) => void;
  onDraftChange: (draft: QuillDraft) => void;
  onExitInline: (regionId: string) => void;
  onShowStructure: () => void;
  onRetryPreview: () => void;
  pdfUrl: string;
  selectedElementId: string;
  onSelect: (elementId: string, sourceVersionId: string) => void;
  onShowStructure: () => void;
}

interface MapPageProps {
  page: RenderMapPage;
  regions: RenderMapRegion[];
  scale: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  showSelectableAreas: boolean;
  selectedElementId: string;
  selectedBlock: EditorBlock | null;
  draft: QuillDraft | null;
  editorResetToken: number;
  inlineSelection: LayoutSelectionIntent | null;
  inlineCommand: InlineEditorCommand | null;
  editorDisabled: boolean;
  onSelect: (intent: LayoutSelectionIntent) => void;
  onDraftChange: (draft: QuillDraft) => void;
  onExitInline: (regionId: string) => void;
  onSelect: (region: RenderMapRegion) => void;
}

const BASE_SCALE = 96 / 72;
const MIN_CUSTOM_SCALE = BASE_SCALE * 0.4;
const MAX_CUSTOM_SCALE = BASE_SCALE * 3;

function locationDescription(region: RenderMapRegion): string {
  const location = region.location ?? {};
  if (region.element_type === "header_paragraph") {
    return String(location.header_footer_type ?? "header").replaceAll("_", " ");
  }
  if (region.element_type === "footer_paragraph") {
    return String(location.header_footer_type ?? "footer").replaceAll("_", " ");
  }
  if (region.element_type === "table_paragraph") {
    return `table ${Number(location.table_index ?? 0) + 1}, row ${Number(location.row_index ?? 0) + 1}, column ${Number(location.column_index ?? 0) + 1}, paragraph ${Number(location.paragraph_index ?? 0) + 1}`;
  }
  return region.element_type.replaceAll("_", " ");
}

function regionLabel(region: RenderMapRegion): string {
  const preview = region.text_preview.trim() || "Empty Word element";
  const action = region.interactive
    ? "Click to edit"
    : `Read-only: ${region.read_only_reason ?? "this structure is not safe to edit"}`;
  return `${locationDescription(region)}, page ${region.page_number}: ${preview}. ${action}.`;
  const type = region.element_type.replaceAll("_", " ");
  if (region.element_type === "header_paragraph") {
    return `${String(location.header_footer_type ?? "header").replaceAll("_", " ")}`;
  }
  if (region.element_type === "footer_paragraph") {
    return `${String(location.header_footer_type ?? "footer").replaceAll("_", " ")}`;
  }
  if (region.element_type === "table_paragraph") {
    return `table ${Number(location.table_index ?? 0) + 1}, row ${Number(location.row_index ?? 0) + 1}, column ${Number(location.column_index ?? 0) + 1}`;
  }
  return type;
}

function regionLabel(region: RenderMapRegion): string {
  const state = region.interactive
    ? "editable"
    : region.read_only_reason ?? "read only";
  const preview = region.text_preview.trim() || "Empty Word element";
  return `${locationDescription(region)}, page ${region.page_number}: ${preview}. ${state}.`;
}

function MapPage({
  page,
  regions,
  scale,
  viewportRef,
  showSelectableAreas,
  selectedElementId,
  selectedBlock,
  draft,
  editorResetToken,
  inlineSelection,
  inlineCommand,
  editorDisabled,
  onSelect,
  onDraftChange,
  onExitInline,
  onSelect,
}: MapPageProps) {
  const pageRef = useRef<HTMLElement>(null);
  const [nearViewport, setNearViewport] = useState(page.page_number <= 2);

  useEffect(() => {
    const pageElement = pageRef.current;
    const root = viewportRef.current;
    if (!pageElement || !root || !("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root, rootMargin: "900px 0px" },
    );
    observer.observe(pageElement);
    return () => observer.disconnect();
  }, [page.page_number, viewportRef]);

  const selectedRegions = useMemo(
    () =>
      regions
        .filter((region) => region.element_id === selectedElementId)
        .sort((left, right) => left.y - right.y || left.x - right.x),
    [regions, selectedElementId],
  );
  const inlineBounds = useMemo(() => {
    if (!selectedRegions.length) return null;
    const left = Math.min(...selectedRegions.map((region) => region.x));
    const top = Math.min(...selectedRegions.map((region) => region.y));
    const right = Math.max(
      ...selectedRegions.map((region) => region.x + region.width),
    );
    const bottom = Math.max(
      ...selectedRegions.map((region) => region.y + region.height),
    );
    return { left, top, width: right - left, height: bottom - top };
  }, [selectedRegions]);

  function pointerIntent(region: RenderMapRegion, event: MouseEvent<HTMLButtonElement>) {
    if (!region.interactive) return;
    const elementRegions = regions
      .filter((candidate) => candidate.element_id === region.element_id)
      .sort((left, right) => left.y - right.y || left.x - right.x);
    const lineIndex = Math.max(
      0,
      elementRegions.findIndex((candidate) => candidate.region_id === region.region_id),
    );
    const bounds = event.currentTarget.getBoundingClientRect();
    const lineFraction = Math.min(
      1,
      Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)),
    );
    onSelect({
      elementId: region.element_id,
      versionId: region.version_id,
      regionId: region.region_id,
      pageNumber: region.page_number,
      caretFraction: (lineIndex + lineFraction) / Math.max(1, elementRegions.length),
      keyboard: false,
      requestId: Date.now(),
    });
  }

  function keyboardIntent(
    region: RenderMapRegion,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!region.interactive) return;
    onSelect({
      elementId: region.element_id,
      versionId: region.version_id,
      regionId: region.region_id,
      pageNumber: region.page_number,
      caretFraction: 0,
      keyboard: true,
      requestId: Date.now(),
    });
  }

  const showInlineEditor = Boolean(
    nearViewport &&
      inlineBounds &&
      inlineSelection?.pageNumber === page.page_number &&
      inlineSelection.elementId === selectedElementId &&
      selectedBlock?.element_id === selectedElementId &&
      draft,
  );

  function activate(
    region: RenderMapRegion,
    event?: KeyboardEvent<HTMLButtonElement>,
  ) {
    if (event && event.key !== "Enter" && event.key !== " ") return;
    if (event) event.preventDefault();
    if (region.interactive) onSelect(region);
  }

  return (
    <article
      ref={pageRef}
      className="render-map-page"
      aria-label={`Page ${page.page_number}`}
      style={{
        width: `${page.width * scale}px`,
        aspectRatio: `${page.width} / ${page.height}`,
      }}
    >
      {nearViewport && (
        <>
          <img
            src={absoluteApiUrl(page.image_url)}
            alt={`Page ${page.page_number} of the Word preview`}
            alt={`Page ${page.page_number} of ${page.page_number === 1 ? "the" : "this"} Word preview`}
            loading={page.page_number <= 2 ? "eager" : "lazy"}
            draggable={false}
          />
          <div
            className={`render-map-overlay${showSelectableAreas ? " show-areas" : ""}`}
            aria-label={`Selectable Word areas on page ${page.page_number}`}
          >
            {regions.map((region) => (
              <button
                type="button"
                key={region.region_id}
                data-render-region-id={region.region_id}
                className={`render-map-region${region.interactive ? " interactive" : " read-only"}${region.element_id === selectedElementId ? " selected" : ""}`}
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`,
                  height: `${region.height * 100}%`,
                }}
                aria-label={regionLabel(region)}
                aria-disabled={!region.interactive}
                title={
                  region.interactive
                    ? `${locationDescription(region)} · Page ${region.page_number}\nClick to edit`
                    : region.read_only_reason ?? "This area is not safe to edit."
                }
                onClick={(event) => pointerIntent(region, event)}
                onKeyDown={(event) => keyboardIntent(region, event)}
              />
            ))}
            {showInlineEditor && inlineBounds && selectedBlock && draft && (
              <div
                className="render-map-inline-layer"
                style={{
                  left: `${inlineBounds.left * 100}%`,
                  top: `${inlineBounds.top * 100}%`,
                  width: `${inlineBounds.width * 100}%`,
                  minHeight: `${inlineBounds.height * 100}%`,
                }}
              >
                <InlineLayoutEditor
                  key={`${selectedBlock.element_id}:${inlineSelection?.requestId}:${editorResetToken}`}
                  block={selectedBlock}
                  value={draft.delta}
                  resetToken={editorResetToken}
                  caretFraction={inlineSelection?.caretFraction ?? 0}
                  command={inlineCommand}
                  disabled={editorDisabled}
                  onChange={onDraftChange}
                  onExit={() => onExitInline(inlineSelection?.regionId ?? "")}
                />
              </div>
            )}
                    ? `Open ${locationDescription(region)} in Edit`
                    : region.read_only_reason ?? "This area is not safe to select."
                }
                onClick={() => activate(region)}
                onKeyDown={(event) => activate(region, event)}
              />
            ))}
          </div>
        </>
      )}
      <span className="render-map-page-number" aria-hidden="true">
        {page.page_number}
      </span>
    </article>
  );
}

export default function WordPreviewOverlay({
  documentName,
  versionId,
  selectedElementId,
  selectedBlock,
  draft,
  editorResetToken,
  inlineSelection,
  inlineCommand,
  editorDisabled,
  onSelect,
  onDraftChange,
  onExitInline,
  onShowStructure,
  onRetryPreview,
  pdfUrl,
  selectedElementId,
  onSelect,
  onShowStructure,
}: WordPreviewOverlayProps) {
  const [renderMap, setRenderMap] = useState<RenderMapResponse | null>(null);
  const [mapError, setMapError] = useState("");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit-width");
  const [customScale, setCustomScale] = useState(BASE_SCALE);
  const [showSelectableAreas, setShowSelectableAreas] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 760, height: 600 });
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let delay = 200;
    let delay = 250;
    const load = async () => {
      try {
        const response = await fetchRenderMap(versionId, controller.signal);
        if (controller.signal.aborted) return;
        if (response.version_id !== versionId) {
          setMapError("The selectable-area map did not match the displayed version.");
          setMapError("The selectable-area map did not match the displayed document version.");
          return;
        }
        setRenderMap(response);
        setMapError("");
        if (["queued", "processing", "not_requested"].includes(response.status)) {
          delay = Math.min(1500, Math.round(delay * 1.45));
        if (["queued", "processing"].includes(response.status)) {
          delay = Math.min(1500, Math.round(delay * 1.5));
          timer = window.setTimeout(load, delay);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setMapError(
          error instanceof Error ? error.message : "Selectable areas could not be loaded.",
          error instanceof Error
            ? error.message
            : "Selectable areas could not be loaded.",
        );
      }
    };
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [versionId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () =>
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [renderMap?.render_id]);

  const pageRegions = useMemo(() => {
    const byPage = new Map<number, RenderMapRegion[]>();
    for (const region of renderMap?.regions ?? []) {
      if (!Number.isFinite(region.x + region.y + region.width + region.height)) continue;
      if (!Number.isFinite(region.x + region.y + region.width + region.height)) {
        continue;
      }
      byPage.set(region.page_number, [
        ...(byPage.get(region.page_number) ?? []),
        region,
      ]);
    }
    for (const regions of byPage.values()) {
      regions.sort((left, right) => left.y - right.y || left.x - right.x);
    }
    return byPage;
  }, [renderMap]);

  const pages = renderMap?.pages ?? [];
  const pagesReady = pages.length > 0;
  const mapReady = Boolean(
    renderMap && ["completed", "partial"].includes(renderMap.status),
  );
  const maxWidth = Math.max(1, ...pages.map((page) => page.width));
  const maxHeight = Math.max(1, ...pages.map((page) => page.height));
  const fitWidthScale = Math.max(0.1, (viewportSize.width - 36) / maxWidth);
  const fitPageScale = Math.max(
    0.1,
    Math.min(fitWidthScale, (viewportSize.height - 36) / maxHeight),
    Math.min(
      fitWidthScale,
      (viewportSize.height - 36) / maxHeight,
    ),
  );
  const scale =
    scaleMode === "fit-width"
      ? fitWidthScale
      : scaleMode === "fit-page"
        ? fitPageScale
        : customScale;
  const zoomPercent = Math.round((scale / BASE_SCALE) * 100);
  const mapReady =
    renderMap &&
    ["completed", "partial"].includes(renderMap.status) &&
    pages.length > 0;

  function zoom(factor: number) {
    setCustomScale(
      Math.min(MAX_CUSTOM_SCALE, Math.max(MIN_CUSTOM_SCALE, scale * factor)),
    );
    setScaleMode("custom");
  }

  const pending = renderMap && ["queued", "processing"].includes(renderMap.status);
  const statusText = mapError
    ? `The controlled preview remains available where possible. ${mapError}`
    : renderMap?.status_detail ?? "Preparing the controlled Word preview.";

  return (
    <div
      className="word-map-preview"
      data-map-status={renderMap?.status ?? "loading"}
      aria-label={`${documentName} controlled Word layout preview`}
    >
      <div className="render-map-toolbar" role="toolbar" aria-label="Word preview controls">
        <button type="button" disabled={!pagesReady} onClick={() => zoom(0.85)} aria-label="Zoom out">
          −
        </button>
        <output aria-label="Zoom level">{pagesReady ? `${zoomPercent}%` : "PDF"}</output>
        <button type="button" disabled={!pagesReady} onClick={() => zoom(1.15)} aria-label="Zoom in">
  function selectRegion(region: RenderMapRegion) {
    if (
      region.version_id !== versionId ||
      renderMap?.version_id !== versionId ||
      !region.interactive
    ) {
      return;
    }
    onSelect(region.element_id, region.version_id);
  }

  const pending = renderMap && ["queued", "processing"].includes(renderMap.status);
  const statusText = mapError
    ? `PDF ready; selectable areas unavailable. ${mapError}`
    : renderMap?.status_detail ?? "The PDF is ready while selectable areas are checked.";

  return (
    <div className="word-map-preview" data-map-status={renderMap?.status ?? "loading"}>
      <div className="render-map-toolbar" role="toolbar" aria-label="Word preview controls">
        <button type="button" disabled={!mapReady} onClick={() => zoom(0.85)} aria-label="Zoom out">
          -
        </button>
        <output aria-label="Zoom level">{mapReady ? `${zoomPercent}%` : "PDF"}</output>
        <button type="button" disabled={!mapReady} onClick={() => zoom(1.15)} aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          disabled={!pagesReady}
          disabled={!mapReady}
          className={scaleMode === "fit-width" ? "active" : ""}
          onClick={() => setScaleMode("fit-width")}
        >
          Fit width
        </button>
        <button
          type="button"
          disabled={!pagesReady}
          disabled={!mapReady}
          className={scaleMode === "fit-page" ? "active" : ""}
          onClick={() => setScaleMode("fit-page")}
        >
          Fit page
        </button>
        <span className="render-map-toolbar-spacer" />
        <button
          type="button"
          aria-pressed={showSelectableAreas}
          disabled={!mapReady || (renderMap?.regions.length ?? 0) === 0}
          onClick={() => setShowSelectableAreas((current) => !current)}
        >
          Show selectable areas
        </button>
        <button type="button" onClick={onShowStructure}>Select from structure</button>
        <button type="button" onClick={onRetryPreview}>Retry preview</button>
      </div>
      <div className="render-map-status" role="status" aria-live="polite">
        <strong>
          {mapReady
            ? renderMap?.status === "partial"
              ? "Ready to edit supported areas"
              : "Ready to edit"
            : pagesReady
              ? "Word layout visible"
              : renderMap?.status === "failed" || mapError
                ? "Direct inline editing unavailable"
                : "Preparing Word layout"}
        <button type="button" onClick={onShowStructure}>
          Select from structure
        </button>
      </div>
      <div className="render-map-status" role="status" aria-live="polite">
        <strong>
          {pending
            ? "Preparing direct selection..."
            : mapReady
            ? renderMap.status === "partial"
              ? "Direct selection is available for supported areas."
              : "Word layout - direct selection ready"
            : renderMap?.status === "failed" || mapError
              ? "Word preview available - direct selection unavailable"
            : "Word layout"}
        </strong>
        <span>{statusText}</span>
        {pending && <span className="spinner" aria-hidden="true" />}
      </div>
      {pagesReady ? (
        <div className="render-map-pages" ref={viewportRef} tabIndex={-1}>
          {pages.map((page) => (
            <MapPage
              key={`${renderMap?.render_id}:${page.page_number}`}
      {mapReady ? (
        <div className="render-map-pages" ref={viewportRef} tabIndex={-1}>
          {pages.map((page) => (
            <MapPage
              key={`${renderMap.render_id}:${page.page_number}`}
              page={page}
              regions={pageRegions.get(page.page_number) ?? []}
              scale={scale}
              viewportRef={viewportRef}
              showSelectableAreas={showSelectableAreas}
              selectedElementId={selectedElementId}
              selectedBlock={selectedBlock}
              draft={draft}
              editorResetToken={editorResetToken}
              inlineSelection={inlineSelection}
              inlineCommand={inlineCommand}
              editorDisabled={editorDisabled}
              onSelect={onSelect}
              onDraftChange={onDraftChange}
              onExitInline={onExitInline}
              onSelect={selectRegion}
            />
          ))}
        </div>
      ) : (
        <div className="render-map-empty" role="status">
          <span className="spinner" aria-hidden="true" />
          <strong>Preparing controlled preview pages</strong>
          <p>You can keep using Edit or navigate elsewhere while Microsoft Word works.</p>
        </div>
        <iframe
          className="render-map-pdf-fallback"
          src={absoluteApiUrl(pdfUrl)}
          title={`${documentName} Word layout preview`}
        />
      )}
    </div>
  );
}
