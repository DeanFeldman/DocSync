export type AppTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "docsync-theme";

export function isAppTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark";
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

export function initialTheme(): AppTheme {
  const bootstrapped = document.documentElement.dataset.theme;
  if (isAppTheme(bootstrapped)) return bootstrapped;

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isAppTheme(stored)) return stored;
  } catch {
    // Local storage is an optional preference layer. The application must
    // remain usable when it is unavailable.
  }

  return systemTheme();
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function persistTheme(theme: AppTheme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching remains immediate even if persistence is unavailable.
  }
}
