import type { SupabaseClient } from "@supabase/supabase-js";

export type SnapshotProviderErrorCode = "authentication_failed" | "object_not_found" | "quota_exceeded" | "provider_unavailable" | "upload_failed" | "download_failed" | "permission_denied";
export class SnapshotProviderError extends Error { constructor(public readonly code: SnapshotProviderErrorCode) { super(code.replaceAll("_", " ")); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = "docsync-workspaces";
function validUuid(value: string): string { if (!UUID.test(value)) throw new SnapshotProviderError("permission_denied"); return value.toLowerCase(); }
function classify(error: unknown, fallback: SnapshotProviderErrorCode): SnapshotProviderError { const status = Number(typeof error === "object" && error !== null && "statusCode" in error ? (error as { statusCode?: string | number }).statusCode : 0); if (status === 401) return new SnapshotProviderError("authentication_failed"); if (status === 403) return new SnapshotProviderError("permission_denied"); if (status === 404) return new SnapshotProviderError("object_not_found"); if (status === 413) return new SnapshotProviderError("quota_exceeded"); if (status >= 500 || !status) return new SnapshotProviderError("provider_unavailable"); return new SnapshotProviderError(fallback); }

export interface WorkspaceSnapshotStorageProvider { uploadSnapshot(snapshotId: string, archive: Blob): Promise<{ objectKey: string }>; downloadSnapshot(snapshotId: string): Promise<Blob>; deleteSnapshot(snapshotId: string): Promise<void>; exists(snapshotId: string): Promise<boolean>; metadata(snapshotId: string): Promise<{ name: string; size: number } | null>; }

/** Storage keys derive from the JWT user returned by Supabase, never a renderer path or email. */
export class SupabaseWorkspaceSnapshotProvider implements WorkspaceSnapshotStorageProvider {
  constructor(private readonly client: SupabaseClient) {}
  private async key(snapshotId: string): Promise<string> { const { data, error } = await this.client.auth.getUser(); if (error || !data.user) throw new SnapshotProviderError("authentication_failed"); return `users/${validUuid(data.user.id)}/snapshots/${validUuid(snapshotId)}.zip`; }
  async uploadSnapshot(snapshotId: string, archive: Blob): Promise<{ objectKey: string }> { const key = await this.key(snapshotId); const { error } = await this.client.storage.from(BUCKET).upload(key, archive, { upsert: false, contentType: "application/zip" }); if (error) throw classify(error, "upload_failed"); return { objectKey: key }; }
  async downloadSnapshot(snapshotId: string): Promise<Blob> { const { data, error } = await this.client.storage.from(BUCKET).download(await this.key(snapshotId)); if (error || !data) throw classify(error, "download_failed"); return data; }
  async deleteSnapshot(snapshotId: string): Promise<void> { const { error } = await this.client.storage.from(BUCKET).remove([await this.key(snapshotId)]); if (error) throw classify(error, "upload_failed"); }
  async exists(snapshotId: string): Promise<boolean> { return (await this.metadata(snapshotId)) !== null; }
  async metadata(snapshotId: string): Promise<{ name: string; size: number } | null> { const key = await this.key(snapshotId); const path = key.split("/"); const { data, error } = await this.client.storage.from(BUCKET).list(path.slice(0, -1).join("/"), { search: path.at(-1) }); if (error) { if (Number(error.statusCode) === 404) return null; throw classify(error, "provider_unavailable"); } const item = data?.find((entry) => entry.name === path.at(-1)); return item ? { name: item.name, size: Number(item.metadata?.size || 0) } : null; }
}

export class CloudSnapshotRepository {
  constructor(private readonly client: SupabaseClient) {}
  async registerDevice(deviceId: string, appVersion: string) { const { data, error } = await this.client.auth.getUser(); if (error || !data.user) throw new SnapshotProviderError("authentication_failed"); const { error: writeError } = await this.client.from("devices").upsert({ id: validUuid(deviceId), user_id: validUuid(data.user.id), app_version: appVersion, last_seen_at: new Date().toISOString() }); if (writeError) throw classify(writeError, "provider_unavailable"); }
  async getCurrentHead() { const { data, error } = await this.client.from("workspace_heads").select("snapshot_id, workspace_revision").maybeSingle(); if (error) throw classify(error, "provider_unavailable"); return data; }
  async createPendingSnapshot(record: Record<string, unknown>) { const { error } = await this.client.from("workspace_snapshots").insert({ ...record, status: "pending" }); if (error) throw classify(error, "provider_unavailable"); }
  async markSnapshotUploaded(snapshotId: string) { const { error } = await this.client.from("workspace_snapshots").update({ status: "uploaded", completed_at: new Date().toISOString() }).eq("id", validUuid(snapshotId)); if (error) throw classify(error, "provider_unavailable"); }
  async promoteSnapshot(snapshotId: string, expectedBaseSnapshotId: string | null, expectedBaseRevision: number) { const { data, error } = await this.client.rpc("promote_workspace_snapshot", { p_snapshot_id: validUuid(snapshotId), p_expected_base_snapshot_id: expectedBaseSnapshotId ? validUuid(expectedBaseSnapshotId) : null, p_expected_base_revision: expectedBaseRevision }); if (error) throw classify(error, "provider_unavailable"); return data; }
  async markSnapshotFailed(snapshotId: string) { const { error } = await this.client.from("workspace_snapshots").update({ status: "failed" }).eq("id", validUuid(snapshotId)); if (error) throw classify(error, "provider_unavailable"); }
  async listRecentSnapshots() { const { data, error } = await this.client.from("workspace_snapshots").select("*").order("created_at", { ascending: false }).limit(20); if (error) throw classify(error, "provider_unavailable"); return data || []; }
}

export const snapshotObjectKeyFor = (userId: string, snapshotId: string) => `users/${validUuid(userId)}/snapshots/${validUuid(snapshotId)}.zip`;
