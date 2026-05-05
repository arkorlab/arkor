import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateHashChange, parseRoute } from "./route";

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

describe("parseRoute — endpoints", () => {
  it("matches `#/endpoints` (list view)", () => {
    withHash("#/endpoints");
    expect(parseRoute()).toEqual({ kind: "endpoints" });
  });

  it("matches `#/endpoints/` (trailing slash)", () => {
    withHash("#/endpoints/");
    expect(parseRoute()).toEqual({ kind: "endpoints" });
  });

  it("extracts the deployment id from `#/endpoints/<id>`", () => {
    withHash("#/endpoints/dep-abc");
    expect(parseRoute()).toEqual({ kind: "endpoint", id: "dep-abc" });
  });

  it("strips a trailing slash from the id segment", () => {
    withHash("#/endpoints/dep-abc/");
    expect(parseRoute()).toEqual({ kind: "endpoint", id: "dep-abc" });
  });

  it("treats trailing slashes after `endpoints` as the list view", () => {
    // `#/endpoints/` is already the list (handled above); this defensive
    // case checks `#/endpoints//`, which becomes `endpoints/` after the
    // trailing-slash trim and still maps to the list rather than to a
    // detail route with an empty id.
    withHash("#/endpoints//");
    expect(parseRoute()).toEqual({ kind: "endpoints" });
  });

  it("decodes percent-escaped reserved characters in the id", () => {
    // Links are built with `encodeURIComponent`. Without a matching
    // decode here, `fetchDeployment(id)` would encode again on the way
    // to the network and the API call would 404 for any id containing
    // reserved chars. Use a slash because the api.ts deployment tests
    // already exercise slash-containing ids end-to-end.
    withHash(`#/endpoints/${encodeURIComponent("a/b")}`);
    expect(parseRoute()).toEqual({ kind: "endpoint", id: "a/b" });
  });

  it("falls back to home when the id has malformed %-escapes", () => {
    // `%2` (no second hex digit) makes `decodeURIComponent` throw
    // URIError. The parser should swallow that and route to home rather
    // than crash the SPA bootstrap.
    withHash("#/endpoints/%2");
    expect(parseRoute()).toEqual({ kind: "home" });
  });
});

describe("evaluateHashChange", () => {
  // The pure decision function used inside `useHashRoute`'s `hashchange`
  // handler. Tests cover the three branches (`ignore` / `rollback` /
  // `navigate`), the rollback recursion, the multi-guard short-circuit,
  // and the direction detection (back vs forward) that picks
  // `history.back()` vs `history.forward()` for the rollback.
  it("returns `navigate` with the parsed route when no guards are registered", () => {
    withHash("#/endpoints");
    expect(
      evaluateHashChange({
        newHash: "#/endpoints",
        lastHash: "#/",
        currentSeq: null,
        lastSeq: 0,
        guards: [],
      }),
    ).toEqual({ kind: "navigate", route: { kind: "endpoints" }, newSeq: 1 });
  });

  it("returns `navigate` when every guard accepts", () => {
    withHash("#/jobs");
    const result = evaluateHashChange({
      newHash: "#/jobs",
      lastHash: "#/",
      currentSeq: null,
      lastSeq: 0,
      guards: [() => true, () => true],
    });
    expect(result).toEqual({
      kind: "navigate",
      route: { kind: "jobs" },
      newSeq: 1,
    });
  });

  it("rollback direction is `back` for forward navigation (push, no current seq)", () => {
    // Forward link click pushes a new entry without our seq tag, so
    // `currentSeq` is null. We undo with `history.back()`.
    withHash("#/jobs");
    let secondCalled = false;
    const result = evaluateHashChange({
      newHash: "#/jobs",
      lastHash: "#/endpoints/abc",
      currentSeq: null,
      lastSeq: 7,
      guards: [
        () => false,
        () => {
          secondCalled = true;
          return true;
        },
      ],
    });
    expect(result).toEqual({ kind: "rollback", direction: "back" });
    // Short-circuit: once a guard says no, the rest don't run. Both for
    // perf and to avoid double-prompting the user.
    expect(secondCalled).toBe(false);
  });

  it("rollback direction is `forward` for browser-Back navigation (currentSeq < lastSeq)", () => {
    // Browser Back from B (seq=2) lands on A (seq=1). We need to undo
    // with `history.forward()` — calling `history.back()` here would
    // step further back and could eject the user from Studio.
    withHash("#/endpoints");
    const result = evaluateHashChange({
      newHash: "#/endpoints",
      lastHash: "#/endpoints/abc",
      currentSeq: 1,
      lastSeq: 2,
      guards: [() => false],
    });
    expect(result).toEqual({ kind: "rollback", direction: "forward" });
  });

  it("rollback direction is `back` when currentSeq equals lastSeq", () => {
    // Edge case: same seq, different hash (shouldn't happen in normal
    // flow, but the function is defensively defined). Default to `back`,
    // matching the "forward push" assumption.
    withHash("#/x");
    const result = evaluateHashChange({
      newHash: "#/x",
      lastHash: "#/y",
      currentSeq: 3,
      lastSeq: 3,
      guards: [() => false],
    });
    expect(result).toEqual({ kind: "rollback", direction: "back" });
  });

  it("returns `ignore` when newHash matches lastHash (rollback recursion)", () => {
    // After the handler triggers `history.back()` / `history.forward()`
    // to roll back a blocked navigation, the browser fires another
    // `hashchange` with the URL restored to `lastHash`. That hashchange
    // MUST resolve to `ignore`, otherwise the guard would re-prompt
    // indefinitely.
    const result = evaluateHashChange({
      newHash: "#/endpoints/abc",
      lastHash: "#/endpoints/abc",
      currentSeq: 5,
      lastSeq: 5,
      guards: [
        () => {
          throw new Error("guards must not run on the no-op hashchange");
        },
      ],
    });
    expect(result).toEqual({ kind: "ignore" });
  });

  it("ignores even when guards would block — equality check wins", () => {
    // Defence-in-depth: the equality check happens before guards are
    // consulted, so a guard that always returns false cannot lock the
    // user into a state where every hashchange (including the rollback)
    // is rejected.
    const result = evaluateHashChange({
      newHash: "#/x",
      lastHash: "#/x",
      currentSeq: 1,
      lastSeq: 1,
      guards: [() => false],
    });
    expect(result).toEqual({ kind: "ignore" });
  });

  it("monotonically bumps newSeq from lastSeq on accepted navigation", () => {
    // The hook stamps `newSeq` into `history.state` so that direction
    // detection on the next `hashchange` knows whether the user clicked
    // a link forward or pressed Back.
    withHash("#/playground");
    const result = evaluateHashChange({
      newHash: "#/playground",
      lastHash: "#/",
      currentSeq: null,
      lastSeq: 41,
      guards: [],
    });
    expect(result).toEqual({
      kind: "navigate",
      route: { kind: "playground", adapterJobId: undefined },
      newSeq: 42,
    });
  });
});
