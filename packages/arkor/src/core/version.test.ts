import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// version.ts has a runtime fallback (`"0.0.0-dev"`) used by vitest where
// tsdown's build-time `define` doesn't apply. The "defined" branch — the
// production path — is otherwise unreachable from a unit test.

const G = globalThis as unknown as Record<string, unknown>;
const ORIG_DEFINED = "__SDK_VERSION__" in G;
const ORIG_VALUE = G.__SDK_VERSION__;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIG_DEFINED) G.__SDK_VERSION__ = ORIG_VALUE;
  else delete G.__SDK_VERSION__;
});

describe("SDK_VERSION", () => {
  it("falls back to '0.0.0-dev' when __SDK_VERSION__ is not defined globally", async () => {
    delete G.__SDK_VERSION__;
    const { SDK_VERSION } = (await import("./version")) as {
      SDK_VERSION: string;
    };
    expect(SDK_VERSION).toBe("0.0.0-dev");
  });

  it("uses the global __SDK_VERSION__ value when tsdown's `define` injected it", async () => {
    G.__SDK_VERSION__ = "9.9.9-test";
    const { SDK_VERSION } = (await import("./version")) as {
      SDK_VERSION: string;
    };
    expect(SDK_VERSION).toBe("9.9.9-test");
  });
});
