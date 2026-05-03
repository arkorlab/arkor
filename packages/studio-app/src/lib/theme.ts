export type Theme = "light" | "dark";

const STORAGE_KEY = "arkor-studio-theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may throw under privacy modes / sandboxed iframes.
    // Fall through to the prefers-color-scheme branch.
  }
  // `matchMedia` can be missing on older WebViews and sandboxed test
  // environments. The pre-paint script in `index.html` already guards
  // it the same way; mirror that here so we degrade to "light" rather
  // than crashing initialization.
  try {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
  } catch {
    // some environments throw on the first matchMedia query — fall through
  }
  return "light";
}

export function setTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  // Some test / SSR environments expose `document` without `window`;
  // guard explicitly so we don't ReferenceError before reaching the
  // try/catch below.
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode, etc.) — silently skip.
  }
}

export function getCurrentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
