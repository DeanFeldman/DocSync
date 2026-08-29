(() => {
  const key = "docsync-theme";
  let theme;
  try {
    const stored = window.docSync?.getThemePreference?.() || localStorage.getItem(key);
    if (stored === "light" || stored === "dark") theme = stored;
    // "system" intentionally resolves below without rewriting the preference.
  } catch {
    // Local preference storage is optional.
  }
  if (!theme) {
    try {
      theme = matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch {
      theme = "light";
    }
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
