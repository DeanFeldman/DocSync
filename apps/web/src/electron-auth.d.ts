interface Window {
  docSync?: {
    openOAuth(url: string): Promise<boolean>; getAuthCallback(): Promise<string | null>; onAuthCallback(listener: (code: string) => void): (() => void) | undefined;
    authStorage?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<boolean>; remove(key: string): Promise<boolean>; clear(): Promise<boolean> };
  };
}
