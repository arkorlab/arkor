import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHashRouter,
  evaluateHashChange,
  parseRoute,
  type HashRouterDeps,
  type Route,
} from "./route";

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

  it("monotonically bumps newSeq from lastSeq when landing on a fresh entry", () => {
    // The hook stamps `newSeq` into `history.state` so that direction
    // detection on the next `hashchange` knows whether the user clicked
    // a link forward or pressed Back. A freshly-pushed entry has
    // `currentSeq === null` and is assigned `lastSeq + 1`.
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

  it("preserves the existing seq when landing on a revisited entry", () => {
    // A→B→C, then Back to B: the B entry already carries seq=1, and the
    // hook MUST keep it at 1 (rather than re-stamp it as seq=3) so that
    // a subsequent Forward to C still computes `currentSeq < lastSeq`
    // correctly. The reviewer-flagged regression: re-stamping B with a
    // higher seq than C broke direction detection and turned the
    // rollback into a `forward()` that ejected the user past C.
    withHash("#/endpoints/b");
    const result = evaluateHashChange({
      newHash: "#/endpoints/b",
      lastHash: "#/endpoints/c",
      currentSeq: 1,
      lastSeq: 2,
      guards: [],
    });
    expect(result).toEqual({
      kind: "navigate",
      route: { kind: "endpoint", id: "b" },
      newSeq: 1,
    });
  });
});

describe("createHashRouter (integration of side effects)", () => {
  // Hook-level coverage that `evaluateHashChange` does NOT give us:
  // verify that the side-effect callbacks (`goBack`, `goForward`,
  // `stampSeq`, `setRoute`) are invoked at the right time and in the
  // right order. The hook itself just wires this up to `history` /
  // `window.location` / React's setRoute, and that wiring is trivial —
  // the meaningful logic is here.

  type Recorder = {
    deps: HashRouterDeps;
    routes: Route[];
    goBackCalls: number;
    goForwardCalls: number;
    stampedSeqs: number[];
    setHash: (hash: string) => void;
    setSeq: (seq: number | null) => void;
  };

  function makeRecorder(
    initialHash: string,
    initialSeq: number | null,
    guards: NavigationGuard[] = [],
  ): Recorder {
    let currentHash = initialHash;
    let currentSeq: number | null = initialSeq;
    const routes: Route[] = [];
    const stampedSeqs: number[] = [];
    const rec: Recorder = {
      routes,
      goBackCalls: 0,
      goForwardCalls: 0,
      stampedSeqs,
      setHash: (h) => {
        currentHash = h;
        // Mock `withHash` so `parseRoute()` (which reads
        // `window.location.hash` directly) returns the right route
        // when `evaluateHashChange` calls it.
        withHash(h);
      },
      setSeq: (s) => {
        currentSeq = s;
      },
      deps: {
        getCurrentHash: () => currentHash,
        getCurrentSeq: () => currentSeq,
        guards,
        setRoute: (r) => routes.push(r),
        goBack: () => {
          rec.goBackCalls++;
        },
        goForward: () => {
          rec.goForwardCalls++;
        },
        stampSeq: (seq) => {
          stampedSeqs.push(seq);
          currentSeq = seq;
        },
      },
    };
    return rec;
  }

  type NavigationGuard = () => boolean;

  it("forwards a fresh push to setRoute and stamps the new seq", () => {
    // User on `#/` (seq=0) clicks a link to `#/endpoints`. Browser
    // pushes a new entry without our seq, so the hook must stamp
    // `seq=1` into it (otherwise the next nav can't tell direction).
    const rec = makeRecorder("#/", 0);
    const router = createHashRouter("#/", 0, rec.deps);

    // Browser-side: URL changes to the new hash, no seq yet.
    rec.setHash("#/endpoints");
    rec.setSeq(null);

    router.onHashChange();

    expect(rec.routes).toEqual([{ kind: "endpoints" }]);
    expect(rec.stampedSeqs).toEqual([1]);
    expect(rec.goBackCalls).toBe(0);
    expect(rec.goForwardCalls).toBe(0);
    expect(router.getLastHash()).toBe("#/endpoints");
    expect(router.getLastSeq()).toBe(1);
  });

  it("does NOT re-stamp seq when landing on a previously-visited entry", () => {
    // A→B→C visited (seqs 0, 1, 2), then Back to B (seq=1). The hook
    // sees `currentSeq === 1` already on the entry, so it must NOT
    // call `stampSeq` again — otherwise B would get bumped to 3 and
    // direction detection on the next Forward would break.
    const rec = makeRecorder("#/endpoints/c", 2);
    const router = createHashRouter("#/endpoints/c", 2, rec.deps);

    rec.setHash("#/endpoints/b");
    rec.setSeq(1);

    router.onHashChange();

    expect(rec.routes).toEqual([{ kind: "endpoint", id: "b" }]);
    expect(rec.stampedSeqs).toEqual([]);
    expect(router.getLastSeq()).toBe(1);
  });

  it("rolls back a forward push (currentSeq=null) via goBack and skips setRoute", () => {
    // The classic "guarded link click" path: a guard refuses, the URL
    // already moved to the new entry, the hook must call goBack to
    // restore the previous URL and must NOT update the React route
    // state (that would render the destination page despite the
    // refusal).
    let denials = 0;
    const guards: NavigationGuard[] = [
      () => {
        denials++;
        return false;
      },
    ];
    const rec = makeRecorder("#/endpoints/a", 5, guards);
    const router = createHashRouter("#/endpoints/a", 5, rec.deps);

    rec.setHash("#/endpoints");
    rec.setSeq(null);

    router.onHashChange();

    expect(denials).toBe(1);
    expect(rec.goBackCalls).toBe(1);
    expect(rec.goForwardCalls).toBe(0);
    expect(rec.routes).toEqual([]);
    // lastHash / lastSeq stay frozen at the pre-navigation values, so
    // the rollback hashchange the browser fires next resolves to
    // `ignore` (newHash === lastHash).
    expect(router.getLastHash()).toBe("#/endpoints/a");
    expect(router.getLastSeq()).toBe(5);
  });

  it("rolls back a browser-Back press (currentSeq < lastSeq) via goForward", () => {
    // User pressed browser Back from B(seq=2) to A(seq=1). The guard
    // refuses. Calling `goBack()` here would step *further* back and
    // could eject the user from the SPA — `goForward()` is what
    // restores the URL to B.
    const guards: NavigationGuard[] = [() => false];
    const rec = makeRecorder("#/endpoints/b", 2, guards);
    const router = createHashRouter("#/endpoints/b", 2, rec.deps);

    rec.setHash("#/endpoints/a");
    rec.setSeq(1);

    router.onHashChange();

    expect(rec.goForwardCalls).toBe(1);
    expect(rec.goBackCalls).toBe(0);
    expect(rec.routes).toEqual([]);
  });

  it("the rollback hashchange (newHash === lastHash) is a no-op", () => {
    // After `goBack()` runs, the browser fires another hashchange with
    // the URL restored to `lastHash`. That hashchange must NOT re-run
    // guards or call setRoute — `evaluateHashChange` returns `ignore`
    // and the router does literally nothing.
    let guardCalls = 0;
    const guards: NavigationGuard[] = [
      () => {
        guardCalls++;
        return false;
      },
    ];
    const rec = makeRecorder("#/endpoints/a", 5, guards);
    const router = createHashRouter("#/endpoints/a", 5, rec.deps);

    // Dispatch a no-op hashchange (URL hasn't actually changed since
    // the last accepted navigation).
    router.onHashChange();

    expect(guardCalls).toBe(0);
    expect(rec.goBackCalls).toBe(0);
    expect(rec.goForwardCalls).toBe(0);
    expect(rec.routes).toEqual([]);
  });

  it("threads multiple accepted forward navigations and bumps seq each time", () => {
    // A→B→C→D, all forward link clicks. The hook should stamp 1, 2, 3
    // sequentially, leaving `lastSeq` at 3 — so a later Back from D
    // would land on C(seq=2), `currentSeq(2) < lastSeq(3)` → forward
    // rollback if a guard refuses.
    const rec = makeRecorder("#/", 0);
    const router = createHashRouter("#/", 0, rec.deps);

    for (const hash of ["#/jobs", "#/playground", "#/endpoints"]) {
      rec.setHash(hash);
      rec.setSeq(null);
      router.onHashChange();
    }

    expect(rec.stampedSeqs).toEqual([1, 2, 3]);
    expect(router.getLastSeq()).toBe(3);
    expect(rec.routes).toHaveLength(3);
    expect(rec.routes[2]).toEqual({ kind: "endpoints" });
  });
});
