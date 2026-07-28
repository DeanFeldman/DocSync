import type { QuillDraft } from "./QuillBlockEditor";
import type { DocumentView, EditorContentResponse, MatchDiscovery, SimilarMatchesResponse } from "./types";

export type WorkspaceMode = "layout" | "edit" | "compare";

export interface WorkspaceViewState {
  mode: WorkspaceMode;
  selectedElementId: string;
  draft: QuillDraft | null;
  scrollTop: Record<WorkspaceMode, number>;
}

type WorkspaceResource =
  | DocumentView
  | EditorContentResponse
  | MatchDiscovery
  | SimilarMatchesResponse
  | unknown;

class BoundedLruCache<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly maximumEntries: number) {}

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maximumEntries) {
      const oldestKey = this.values.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.values.delete(oldestKey);
    }
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.values.keys()) {
      if (predicate(key)) this.values.delete(key);
    }
  }

  clear(): void {
    this.values.clear();
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }
}

class WorkspaceResourceStore {
  private readonly values = new BoundedLruCache<WorkspaceResource>(48);
  private readonly inFlight = new Map<string, Promise<WorkspaceResource>>();
  private readonly epochs = new Map<string, number>();
  private globalEpoch = 0;

  get<T extends WorkspaceResource>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T extends WorkspaceResource>(key: string, value: T): void {
    this.values.set(key, value);
  }

  load<T extends WorkspaceResource>(
    key: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const keyEpoch = this.epochs.get(key) ?? 0;
    const storeEpoch = this.globalEpoch;
    const request = loader()
      .then((value) => {
        if (
          storeEpoch === this.globalEpoch &&
          keyEpoch === (this.epochs.get(key) ?? 0)
        ) {
          this.values.set(key, value);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, request);
    return request;
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    const knownKeys = new Set([
      ...this.values.keys(),
      ...this.inFlight.keys(),
    ]);
    for (const key of knownKeys) {
      if (!predicate(key)) continue;
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    }
    this.values.deleteWhere(predicate);
  }

  clear(): void {
    this.globalEpoch += 1;
    this.values.clear();
  }
}

const resources = new WorkspaceResourceStore();
const viewStates = new BoundedLruCache<WorkspaceViewState>(24);

function key(...parts: string[]): string {
  return parts.join("|");
}

export function editorResourceKey(
  documentSetId: string,
  documentId: string,
  versionId: string,
): string {
  return key("editor", documentSetId, documentId, versionId);
}

export function wordPreviewResourceKey(
  documentSetId: string,
  documentId: string,
  versionId: string,
): string {
  return key("word-preview", documentSetId, documentId, versionId);
}

export function exactMatchesResourceKey(
  documentSetId: string,
  documentId: string,
  versionScope: string,
  elementId: string,
): string {
  return key("exact-matches", documentSetId, documentId, versionScope, elementId);
}

export function nearMatchesResourceKey(
  documentSetId: string,
  documentId: string,
  versionScope: string,
  elementId: string,
): string {
  return key("near-matches", documentSetId, documentId, versionScope, elementId);
}

export function versionHistoryResourceKey(
  documentSetId: string,
  documentId: string,
  versionId: string,
): string {
  return key("version-history", documentSetId, documentId, versionId);
}

export function workspaceViewStateKey(
  documentSetId: string,
  documentId: string,
  versionId: string,
): string {
  return key("view-state", documentSetId, documentId, versionId);
}

export function getWorkspaceResource<T extends WorkspaceResource>(
  resourceKey: string,
): T | undefined {
  return resources.get<T>(resourceKey);
}

export function setWorkspaceResource<T extends WorkspaceResource>(
  resourceKey: string,
  value: T,
): void {
  resources.set(resourceKey, value);
}

export function loadWorkspaceResource<T extends WorkspaceResource>(
  resourceKey: string,
  loader: () => Promise<T>,
): Promise<T> {
  return resources.load(resourceKey, loader);
}

export function getWorkspaceViewState(
  stateKey: string,
): WorkspaceViewState | undefined {
  return viewStates.get(stateKey);
}

export function setWorkspaceViewState(
  stateKey: string,
  state: WorkspaceViewState,
): void {
  viewStates.set(stateKey, state);
}

export function clearWorkspaceResourcesForDocument(
  documentSetId: string,
  documentId: string,
): void {
  const resourcePrefix = `|${documentSetId}|${documentId}|`;
  resources.deleteWhere((resourceKey) => resourceKey.includes(resourcePrefix));
  viewStates.deleteWhere((stateKey) => stateKey.includes(resourcePrefix));
}

export function clearWorkspaceViewStateForDocument(
  documentSetId: string,
  documentId: string,
): void {
  const resourcePrefix = `|${documentSetId}|${documentId}|`;
  viewStates.deleteWhere((stateKey) => stateKey.includes(resourcePrefix));
}

export function clearWorkspaceResourcesForSet(documentSetId: string): void {
  const setPrefix = `|${documentSetId}|`;
  resources.deleteWhere((resourceKey) => resourceKey.includes(setPrefix));
  viewStates.deleteWhere((stateKey) => stateKey.includes(setPrefix));
}

export function invalidateDocumentHeadResources(
  documentSetId: string,
  documentId: string,
): void {
  const prefix = `version-history|${documentSetId}|${documentId}|`;
  resources.deleteWhere((resourceKey) => resourceKey.startsWith(prefix));
}

export function clearAllWorkspaceResources(): void {
  resources.clear();
  viewStates.clear();
}
