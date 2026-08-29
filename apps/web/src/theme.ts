export type AppTheme = "light" | "dark";
export type ThemePreference = "system" | AppTheme;

export const THEME_STORAGE_KEY = "docsync-theme";

type ThemeBridge = {
  getThemePreference?: () => unknown;
  setThemePreference?: (preference: ThemePreference) => void;
};

function themeBridge(): ThemeBridge | undefined {
  return (window as typeof window & { docSync?: ThemeBridge }).docSync;
}

export function isAppTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark";
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isAppTheme(value);
}

export function systemTheme(): AppTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function initialThemePreference(): ThemePreference {
  try {
    const desktopPreference = themeBridge()?.getThemePreference?.();
    if (isThemePreference(desktopPreference)) return desktopPreference;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    // Local storage is an optional preference layer. The application must
    // remain usable when it is unavailable.
  }

  return "system";
}

export function resolveTheme(preference: ThemePreference): AppTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function persistThemePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme switching remains immediate even if persistence is unavailable.
  }
  try {
    themeBridge()?.setThemePreference?.(preference);
  } catch {
    // Browser builds do not have the optional desktop bridge.
  }
}
