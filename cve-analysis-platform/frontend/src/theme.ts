// Light/dark theme switcher driven by a `data-theme` attribute on <html>.
// Preference is persisted to localStorage. Default = OS preference.

export type Theme = "light" | "dark";

const STORAGE_KEY = "cve-ui-theme";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return getSystemTheme();
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent("theme-change", { detail: theme }));
}

export function initTheme(): void {
  setTheme(getTheme());
}
