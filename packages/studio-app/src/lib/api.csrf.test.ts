// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIG_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `vi.stubGlobal`. The EventSource
  // case below uses stubGlobal, so without an explicit unstub the fake
  // class would bleed into any later test that touches the real
  // EventSource. Mirrors the cleanup in `route.test.ts` /
  // `lib/theme.test.ts`.
  vi.unstubAllGlobals();
});

describe("api CSRF token wiring", () => {
  let seenHeaders: Headers | null = null;

  beforeEach(() => {
    seenHeaders = null;
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ jobs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  it("apiFetch attaches the token from <meta name=\"arkor-studio-token\"> as X-Arkor-Studio-Token", async () => {
    // The test setup file injects the meta tag at boot, mirroring the
    // production `index.html` Studio renders for the SPA. If `api.ts`
    // ever stops reading the meta tag at module load, real Studio
    // requests start 403ing because cross-origin tabs can't read the
    // tag and the server's middleware rejects unauthenticated /api/*.
    // This test catches that regression at the unit level so the
    // component suites don't have to thread header assertions through
    // every fetch mock.
    const { fetchJobs } = await import("./api");
    await fetchJobs();
    expect(seenHeaders?.get("X-Arkor-Studio-Token")).toBe("test-token");
  });

  it("fetchJobs surfaces the studio server's 403 rejection as a tagged error", async () => {
    // When the Studio server's `/api/*` middleware rejects a request
    // (missing/stale token, host-header mismatch, dev restarted and
    // minted a fresh token while the SPA still holds the old one),
    // it returns 403. `apiFetch` does not throw on non-2xx itself —
    // `json()` does, and the error string is what the SPA surfaces to
    // the user. If a future refactor silently swallows 403 the SPA
    // would render an empty state instead of prompting the user to
    // restart `arkor dev`; this regression test pins the contract.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
        }),
    ) as typeof fetch;
    const { fetchJobs } = await import("./api");
    await expect(fetchJobs()).rejects.toThrow(/403/);
  });

  it("openJobEvents threads the token through the studioToken query param", async () => {
    // EventSource cannot carry custom headers, so the SPA falls back to
    // a query parameter. The Studio server's middleware accepts either,
    // and breaking this fallback would silently kill the live job-events
    // stream in JobDetail.
    const { openJobEvents } = await import("./api");
    let constructedUrl = "";
    class CapturedEventSource {
      constructor(url: string) {
        constructedUrl = url;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", CapturedEventSource);
    const es = openJobEvents("job-123");
    es.close();
    expect(constructedUrl).toBe(
      "/api/jobs/job-123/events?studioToken=test-token",
    );
  });
});
