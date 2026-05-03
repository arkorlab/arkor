import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute } from "./route";

// `parseRoute` reads `window.location.hash` directly, so we stub
// `window` per-test (vitest runs in a node environment by default —
// see vitest.config.ts) instead of pulling in jsdom.

function withHash(hash: string): void {
  vi.stubGlobal("window", { location: { hash } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRoute — home", () => {
  it("returns home for an empty hash", () => {
    withHash("");
    expect(parseRoute()).toEqual({ kind: "home" });
  });

  it("returns home for `#/`", () => {
    withHash("#/");
    expect(parseRoute()).toEqual({ kind: "home" });
  });

  it("returns home for unknown paths", () => {
    withHash("#/something-else");
    expect(parseRoute()).toEqual({ kind: "home" });
  });
});

describe("parseRoute — jobs index", () => {
  it("matches `#/jobs`", () => {
    withHash("#/jobs");
    expect(parseRoute()).toEqual({ kind: "jobs" });
  });

  it("matches `#/jobs/` (trailing slash)", () => {
    withHash("#/jobs/");
    expect(parseRoute()).toEqual({ kind: "jobs" });
  });

  it("matches `#/jobs/?foo=bar` (trailing slash + query)", () => {
    // Regression for the round-of-reviews where trimming trailing
    // slashes on the raw hash before splitting the query left a
    // dangling `/` on the path and the route fell through to home.
    withHash("#/jobs/?foo=bar");
    expect(parseRoute()).toEqual({ kind: "jobs" });
  });
});

describe("parseRoute — job detail", () => {
  it("extracts the job id from `#/jobs/<id>`", () => {
    withHash("#/jobs/abc123");
    expect(parseRoute()).toEqual({ kind: "job", id: "abc123" });
  });

  it("strips a trailing slash from the id segment", () => {
    withHash("#/jobs/abc123/");
    expect(parseRoute()).toEqual({ kind: "job", id: "abc123" });
  });
});

describe("parseRoute — playground", () => {
  it("matches `#/playground` with no adapter id", () => {
    withHash("#/playground");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: undefined,
    });
  });

  it("matches `#/playground/` (trailing slash)", () => {
    withHash("#/playground/");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: undefined,
    });
  });

  it("extracts an adapter id from `?adapter=<id>`", () => {
    withHash("#/playground?adapter=job-xyz");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: "job-xyz",
    });
  });

  it("extracts an adapter id with a trailing slash before the query", () => {
    withHash("#/playground/?adapter=job-xyz");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: "job-xyz",
    });
  });

  it("treats `?adapter=` (empty value) as absent", () => {
    withHash("#/playground?adapter=");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: undefined,
    });
  });

  it("treats `?adapter=  ` (whitespace-only) as absent", () => {
    withHash("#/playground?adapter=%20%20");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: undefined,
    });
  });

  it("ignores other query params", () => {
    withHash("#/playground?foo=bar&adapter=job-xyz&baz=qux");
    expect(parseRoute()).toEqual({
      kind: "playground",
      adapterJobId: "job-xyz",
    });
  });
});
