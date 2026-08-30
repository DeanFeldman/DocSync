import { useCallback, useEffect, useRef, useState } from "react";
import { CloudSnapshotRepository, snapshotObjectKeyFor, SnapshotProviderError, SupabaseWorkspaceSnapshotProvider } from "./cloudSnapshots";
import { supabase } from "./auth";
import { useAuthenticatedUser } from "./AuthGate";

type BackupState = "clean" | "dirty" | "snapshot_creating" | "uploading" | "promoting" | "synced" | "backup_failed" | "conflict";
type LocalState = { state: BackupState; revision?: number; snapshot_id?: string; last_successful_backup?: string; dirty_generation?: number; pending_snapshot_id?: string };
const initial: LocalState = { state: "clean", dirty_generation: 0 };

export default function CloudBackup() {
  const { user, deviceId } = useAuthenticatedUser(); const [local, setLocal] = useState<LocalState>(initial); const busy = useRef(false); const generation = useRef(0); const timer = useRef<number | undefined>(undefined);
  const persist = useCallback(async (next: LocalState) => { setLocal(next); await window.docSync?.cloudBackup?.setState(next); }, []);
  const backup = useCallback(async () => {
    if (!supabase || busy.current || !deviceId) return; busy.current = true; const started = generation.current;
    try {
      await persist({ ...local, state: "snapshot_creating", dirty_generation: started });
      const created = await fetch("/api/cloud-snapshots", { method: "POST" }); if (!created.ok) throw new Error("snapshot");
      const snapshot = await created.json() as { snapshot_id: string; sha256: string; archive_size_bytes: number; workspace_revision: number };
      const provider = new SupabaseWorkspaceSnapshotProvider(supabase); const repository = new CloudSnapshotRepository(supabase);
      const head = await repository.getCurrentHead(); const objectKey = snapshotObjectKeyFor(user.id, snapshot.snapshot_id);
      await repository.registerDevice(deviceId, "1.18.0");
      await repository.createPendingSnapshot({ id: snapshot.snapshot_id, user_id: user.id, device_id: deviceId, storage_provider: "supabase", storage_bucket: "docsync-workspaces", storage_object_key: objectKey, sha256: snapshot.sha256, archive_size_bytes: snapshot.archive_size_bytes, workspace_revision: snapshot.workspace_revision, base_snapshot_id: head?.snapshot_id ?? null, docsync_version: "1.18.0", database_schema_version: 9 });
      await persist({ ...local, state: "uploading", pending_snapshot_id: snapshot.snapshot_id, dirty_generation: started });
      const archive = await fetch(`/api/cloud-snapshots/${snapshot.snapshot_id}/archive`); if (!archive.ok) throw new Error("archive"); await provider.uploadSnapshot(snapshot.snapshot_id, await archive.blob());
      const metadata = await provider.metadata(snapshot.snapshot_id); if (!metadata || metadata.size !== snapshot.archive_size_bytes) throw new Error("verification");
      await repository.markSnapshotUploaded(snapshot.snapshot_id); await persist({ ...local, state: "promoting", pending_snapshot_id: snapshot.snapshot_id, dirty_generation: started });
      const promoted = await repository.promoteSnapshot(snapshot.snapshot_id, head?.snapshot_id ?? null, head?.workspace_revision ?? 0) as { status?: string; workspace_revision?: number };
      if (promoted.status === "conflict") { await persist({ ...local, state: "conflict", pending_snapshot_id: snapshot.snapshot_id, dirty_generation: generation.current }); return; }
      await persist({ state: generation.current === started ? "synced" : "dirty", revision: promoted.workspace_revision, snapshot_id: snapshot.snapshot_id, last_successful_backup: new Date().toISOString(), dirty_generation: generation.current });
    } catch (error) { const state = error instanceof SnapshotProviderError && error.code === "permission_denied" ? "backup_failed" : "backup_failed"; await persist({ ...local, state, dirty_generation: generation.current }); }
    finally { busy.current = false; if (generation.current > started) { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void backup(), 30_000); } }
  }, [deviceId, local, persist, user.id]);
  useEffect(() => { void window.docSync?.cloudBackup?.getState().then((value) => { const recovered = value as Partial<LocalState>; setLocal(["snapshot_creating", "uploading", "promoting"].includes(recovered.state || "") ? { ...recovered, state: "backup_failed" } as LocalState : { ...initial, ...recovered }); }); }, []);
  useEffect(() => { const dirty = () => { generation.current += 1; void persist({ ...local, state: "dirty", dirty_generation: generation.current }); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void backup(), 30_000); }; window.addEventListener("docsync:workspace-mutated", dirty); return () => { window.removeEventListener("docsync:workspace-mutated", dirty); window.clearTimeout(timer.current); }; }, [backup, local, persist]);
  const label = local.state === "synced" ? "✓ Backed up" : local.state === "dirty" ? "Backup pending" : local.state === "backup_failed" ? "Backup failed" : local.state === "conflict" ? "Conflict" : ["snapshot_creating", "uploading", "promoting"].includes(local.state) ? "Backing up…" : "Cloud unavailable";
  return <div className="cloud-backup"><span title={local.last_successful_backup ? `Last backup: ${new Date(local.last_successful_backup).toLocaleString()}` : undefined}>{label}</span><button type="button" className="quiet-button" disabled={busy.current} onClick={() => void backup()}>{local.state === "backup_failed" ? "Retry" : "Back up now"}</button></div>;
}
