interface Window {
  docSync?: {
    openOAuth(url: string): Promise<boolean>; getAuthCallback(): Promise<string | null>; onAuthCallback(listener: (code: string) => void): (() => void) | undefined;
    authStorage?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<boolean>; remove(key: string): Promise<boolean>; clear(): Promise<boolean> };
    cloudBackup?: { getState(): Promise<Record<string, unknown>>; setState(value: Record<string, unknown>): Promise<boolean> };
    activateAccount(userId: string): Promise<AccountActivation>;
    getLegacyMigration(): Promise<AccountActivation>;
    importLegacyWorkspace(): Promise<AccountActivation>;
    declineLegacyMigration(): Promise<AccountActivation>;
    deactivateAccount(): Promise<boolean>;
  };
}

interface AccountActivation { workspace_ready?: boolean; legacy_workspace_detected: boolean; migration_ready: boolean; state: "none" | "migration_ready" | "migration_copying" | "migration_validating" | "migration_complete" | "migration_failed" | "migration_declined" | "migration_conflict"; message?: string; device_id?: string; }
