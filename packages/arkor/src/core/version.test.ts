import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./version";

// version.ts uses `typeof __SDK_VERSION__ !== "undefined" ? … : "0.0.0-dev"`
// where `__SDK_VERSION__` is a free identifier replaced textually by
// tsdown's build-time `define`. After the transform, the ternary is dead
// code (the artifact contains a literal version string), so the
// "defined" branch is only ever taken in the built bundle: not at
// runtime in any environment a unit test can simulate. Setting
// `globalThis.__SDK_VERSION__` doesn't help: it might happen to satisfy
// `typeof __SDK_VERSION__` on V8 in some scope chains, but that's a
// host-specific accident and not the production path either.
//
// We therefore only assert the runtime fallback that vitest workers
// actually take.
describe("SDK_VERSION", () => {
  it("falls back to '0.0.0-dev' when tsdown's `define` did not run", () => {
    expect(SDK_VERSION).toBe("0.0.0-dev");
  });
});
