interface DocSyncLocalWorkspace {
  id: string;
  name: string;
  active: boolean;
}

interface Window {
  docSync?: {
    prepareOffice?(): Promise<string | null>;
    openOfficeSetupGuide?(): Promise<void>;
    localData?: {
      listWorkspaces(): Promise<DocSyncLocalWorkspace[]>;
      openWorkspace(id: string): Promise<void>;
      finishImport(id: string): Promise<void>;
      discardImport(id: string): Promise<void>;
    };
  };
}
