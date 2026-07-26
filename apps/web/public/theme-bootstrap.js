(() => {
  const key = "docsync-theme";
  let theme;
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark") theme = stored;
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
