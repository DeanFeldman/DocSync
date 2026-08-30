interface Window {
  docSync?: {
    openOAuth(url: string): Promise<boolean>; getAuthCallback(): Promise<string | null>; onAuthCallback(listener: (code: string) => void): (() => void) | undefined;
    authStorage?: { get(): Promise<string | null>; set(value: string): Promise<boolean>; remove(): Promise<boolean> };
  };
}
