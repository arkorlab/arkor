import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentTheme, getInitialTheme, setTheme } from "./theme";

// theme.ts inspects `window` / `document` at call time, so we stub
// both per-test instead of relying on a jsdom environment (which the
// rest of the suite intentionally avoids — see vitest.config.ts).

interface FakeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function stubBrowser({
  storage,
  prefersDark,
  documentTheme,
}: {
  storage?: FakeStorage;
  prefersDark?: boolean;
  documentTheme?: "light" | "dark" | undefined;
} = {}) {
  const matchMedia = vi.fn((query: string) => ({
    matches:
      prefersDark === true && query === "(prefers-color-scheme: dark)",
  }));
  const dataset: Record<string, string | undefined> = {};
  if (documentTheme !== undefined) dataset.theme = documentTheme;
  vi.stubGlobal("window", { localStorage: storage, matchMedia });
  vi.stubGlobal("document", { documentElement: { dataset } });
  return { dataset, matchMedia };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getInitialTheme", () => {
  it("returns the persisted value when localStorage holds 'dark'", () => {
    stubBrowser({
      storage: {
        getItem: () => "dark",
        setItem: () => {},
      },
    });
    expect(getInitialTheme()).toBe("dark");
  });

  it("returns the persisted value when localStorage holds 'light'", () => {
    stubBrowser({
      storage: {
        getItem: () => "light",
        setItem: () => {},
      },
    });
    expect(getInitialTheme()).toBe("light");
  });

  it("falls back to prefers-color-scheme: dark when localStorage is empty", () => {
    stubBrowser({
      storage: { getItem: () => null, setItem: () => {} },
      prefersDark: true,
    });
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to light when neither localStorage nor matchMedia indicate dark", () => {
    stubBrowser({
      storage: { getItem: () => null, setItem: () => {} },
      prefersDark: false,
    });
    expect(getInitialTheme()).toBe("light");
  });

  it("ignores invalid stored values and falls through to prefers-color-scheme", () => {
    stubBrowser({
      storage: { getItem: () => "purple", setItem: () => {} },
      prefersDark: true,
    });
    expect(getInitialTheme()).toBe("dark");
  });

  it("survives localStorage.getItem throwing (privacy mode / sandboxed iframe)", () => {
    stubBrowser({
      storage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {},
      },
      prefersDark: true,
    });
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to light when matchMedia is missing entirely", () => {
    // Older WebViews / embedded environments expose `window` without
    // `matchMedia`. The function should degrade to "light" rather than
    // crash on the unguarded call.
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(getInitialTheme()).toBe("light");
  });

  it("falls back to light when matchMedia throws", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => {} },
      matchMedia: () => {
        throw new Error("not supported");
      },
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(getInitialTheme()).toBe("light");
  });
});

describe("setTheme", () => {
  it("writes the chosen theme to documentElement.dataset and localStorage", () => {
    const setItem = vi.fn();
    const { dataset } = stubBrowser({
      storage: { getItem: () => null, setItem },
    });
    setTheme("dark");
    expect(dataset.theme).toBe("dark");
    expect(setItem).toHaveBeenCalledWith("arkor-studio-theme", "dark");
  });

  it("still updates the dataset when localStorage.setItem throws", () => {
    const { dataset } = stubBrowser({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
      },
    });
    expect(() => setTheme("dark")).not.toThrow();
    expect(dataset.theme).toBe("dark");
  });
});

describe("getCurrentTheme", () => {
  it("reads documentElement.dataset.theme === 'dark'", () => {
    stubBrowser({ documentTheme: "dark" });
    expect(getCurrentTheme()).toBe("dark");
  });

  it("returns 'light' for any other value (or unset)", () => {
    stubBrowser({ documentTheme: "light" });
    expect(getCurrentTheme()).toBe("light");
    stubBrowser({});
    expect(getCurrentTheme()).toBe("light");
  });
});
