import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as clack from "@clack/prompts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock `open` so the OAuth flow doesn't try to spawn a real browser.
// The mock also delivers the loopback callback by inspecting the
// authorize URL it's invoked with — that's how we drive the PKCE flow
// to completion from a test.
vi.mock("open", () => ({
  default: vi.fn(),
}));

import open from "open";
import { runLogin } from "./login";
import { readCredentials } from "../../core/credentials";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
// `os.homedir()` reads USERPROFILE on Windows; HOME-only redirection leaves
// Windows runs reading/writing the real user profile and cross-contaminating
// tests via `~/.arkor/credentials.json`.
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CI = process.env.CI;
const ORIG_FETCH = globalThis.fetch;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-login-test-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
  // Force isInteractive() → false so promptSelect returns its initialValue
  // instead of trying to open a real clack prompt.
  process.env.CI = "1";
  vi.mocked(open).mockReset();
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIG_CI !== undefined) process.env.CI = ORIG_CI;
  else delete process.env.CI;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
  globalThis.fetch = ORIG_FETCH;
  // `vi.spyOn` does not auto-restore between tests in this project's
  // vitest config (no `restoreMocks: true`), so spies on `clack.log.*`
  // would otherwise leak — accumulating call records across tests and
  // causing later assertions to see calls from earlier ones.
  vi.restoreAllMocks();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("runLogin", () => {
  // The flag rejection lives both in `main.ts` (so the CLI layer fails
  // before any I/O) and in `runLogin` itself (so programmatic callers
  // can't bypass it). Test the function-level guard directly — the CLI
  // layer is a one-liner that delegates to the same check.
  it("rejects --oauth and --anonymous together", async () => {
    // No fetch mock: the guard must trip before we touch the network.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    await expect(
      runLogin({ oauth: true, anonymous: true }),
    ).rejects.toThrow(/--oauth \/ --anonymous, not both/);
    expect(await readCredentials()).toBeNull();
  });

  // PKCE needs a browser callback that CI runners can't satisfy, and the
  // loopback server has no timeout. Without an early guard, `--oauth` in
  // CI would hang indefinitely waiting for a redirect that will never
  // come. The guard is gated on `process.env.CI` (set by `beforeEach`)
  // and sits *after* the OAuth-availability check so deployments that
  // don't even offer OAuth surface "OAuth is not configured" first
  // (covered by the next test). Local headless flows like
  // `arkor login --oauth --no-browser | tee` are not blocked because
  // `CI` is unset there even though stdout isn't a TTY.
  it("throws when --oauth is passed in CI", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(runLogin({ oauth: true })).rejects.toThrow(
      /CI runners can't complete/,
    );
    expect(await readCredentials()).toBeNull();
  });

  // `--oauth` is an explicit opt-in. If the deployment doesn't advertise
  // OAuth, silently falling back to anon would mask a misconfiguration the
  // user is actively asking us to surface. Keep the failure loud.
  it("throws when --oauth is passed but the deployment has no OAuth config", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(runLogin({ oauth: true })).rejects.toThrow(
      /OAuth is not configured/,
    );
    expect(await readCredentials()).toBeNull();
  });

  it("--anonymous skips the cli/config probe and bootstraps directly", async () => {
    // The explicit `--anonymous` flag must reach the anonymous path
    // without first hitting `/v1/auth/cli/config`; that probe is wasted
    // bandwidth and surfaces confusing errors when the deployment
    // hasn't enabled OAuth at all.
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runLogin({ anonymous: true });
    expect(seenUrls).toEqual(["http://mock-cloud-api/v1/auth/anonymous"]);
    expect(await readCredentials()).toMatchObject({
      mode: "anon",
      anonymousId: "anon-aid",
    });
  });

  it("falls back to anon (with an info hint) when OAuth is not configured and no --oauth flag", async () => {
    // Distinct from the `--oauth + no OAuth` rejection covered above:
    // without the explicit flag, the CLI degrades gracefully rather than
    // erroring. This is the path most "fresh local env" users hit.
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runLogin();
    expect(await readCredentials()).toMatchObject({
      mode: "anon",
      anonymousId: "anon-aid",
    });
  });

  // In non-interactive contexts (CI, piped stdout) `promptSelect` returns
  // its `initialValue` instead of blocking on a prompt. The choice to
  // default to anonymous matters because OAuth needs a browser callback
  // CI can't satisfy — silently bootstrapping anon is safer than hanging.
  it("defaults to anonymous in non-interactive contexts even when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runLogin();
    expect(await readCredentials()).toMatchObject({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "anon-aid",
    });
  });

  // The persistence-nudge gating contract is documented in
  // `cli/anonymous.ts`: warn fires only when `oauthAvailable === true`.
  // Lock that down with output spies so the gating doesn't silently
  // regress to "always show" or "never show" on either of the three
  // anon-issuance paths through `runAnonymousLogin`.
  describe("anon-issuance output (ANON_PERSISTENCE_NUDGE gating)", () => {
    const okConfigResponse = () =>
      new Response(
        JSON.stringify({
          auth0Domain: "tenant.auth0.com",
          clientId: "client-id",
          audience: "https://api.arkor.ai",
          callbackPorts: [4000],
        }),
        { status: 200 },
      );
    const noOauthConfigResponse = () =>
      new Response(
        JSON.stringify({
          auth0Domain: null,
          clientId: null,
          audience: null,
          callbackPorts: [],
        }),
        { status: 200 },
      );
    const okAnonResponse = () =>
      new Response(
        JSON.stringify({
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        }),
        { status: 200 },
      );

    it("fires the warn on picker → Anonymous when OAuth is configured", async () => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/cli/config")) return okConfigResponse();
        if (url.endsWith("/v1/auth/anonymous")) return okAnonResponse();
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const infoSpy = vi.spyOn(clack.log, "info");
      const warnSpy = vi.spyOn(clack.log, "warn");

      await runLogin();

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Arkor Cloud recognises this client"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Anonymous sessions aren't guaranteed to persist",
        ),
      );
    });

    // The `--anonymous` shortcut deliberately skips the cfg fetch (so a
    // partially-degraded cloud-api can't block the only flow that doesn't
    // need it). Per the contract in `cli/anonymous.ts`, that means
    // `oauthAvailable` is undefined and the warn must be suppressed —
    // erring on suppression keeps users on rare anon-only deployments
    // from being pointed at `arkor login --oauth`, which would fail.
    it("suppresses the warn on the explicit --anonymous shortcut", async () => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/anonymous")) return okAnonResponse();
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const infoSpy = vi.spyOn(clack.log, "info");
      const warnSpy = vi.spyOn(clack.log, "warn");

      await runLogin({ anonymous: true });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Arkor Cloud recognises this client"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Anonymous sessions aren't guaranteed to persist",
        ),
      );
    });

    it("suppresses the warn when OAuth is not configured", async () => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/cli/config")) return noOauthConfigResponse();
        if (url.endsWith("/v1/auth/anonymous")) return okAnonResponse();
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const infoSpy = vi.spyOn(clack.log, "info");
      const warnSpy = vi.spyOn(clack.log, "warn");

      await runLogin();

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Arkor Cloud recognises this client"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Anonymous sessions aren't guaranteed to persist",
        ),
      );
    });
  });

  it("completes the PKCE flow end-to-end and persists Auth0 credentials when --oauth + non-CI", async () => {
    // Lift the CI guard: --oauth is rejected in CI before any browser
    // interaction, so we have to pretend we're on a developer machine.
    delete process.env.CI;

    // Capture the redirect URL passed to `open` so the test can hit the
    // loopback callback with a code+state that match what the SDK
    // generated. Fire the callback as a background promise to keep
    // runLogin's `loopback.waitForCallback` resolving cleanly.
    vi.mocked(open).mockImplementation((async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state");
      const redirect = parsed.searchParams.get("redirect_uri");
      // Hit the loopback server with the matching state. We use setTimeout(0)
      // so the SDK has a chance to await its server's `waitForCallback`
      // before we fire the request — and use ORIG_FETCH so the request
      // actually reaches the real TCP socket instead of being intercepted
      // by the test's mock fetch.
      setTimeout(() => {
        void ORIG_FETCH(`${redirect}?code=auth-code&state=${state}`);
      }, 0);
      return undefined;
    }) as never);

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            // 0 → bind on any free port (real loopback server in the SDK).
            callbackPorts: [0],
          }),
          { status: 200 },
        );
      }
      // /callback requests run through ORIG_FETCH (above, in the `open`
      // mock), so they reach the real loopback server directly. This
      // branch only catches accidental misconfigs that route them
      // through the test mock instead — fail loudly to flag the bug.
      if (url.startsWith("http://127.0.0.1") && url.includes("/callback")) {
        throw new Error(
          `loopback callback hit the mock fetch — should have used ORIG_FETCH: ${url}`,
        );
      }
      if (url === "https://tenant.auth0.com/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "auth0-at",
            refresh_token: "auth0-rt",
            id_token: "auth0-id",
            expires_in: 7200,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runLogin({ oauth: true, noBrowser: false });

    const creds = await readCredentials();
    expect(creds).toMatchObject({
      mode: "auth0",
      accessToken: "auth0-at",
      refreshToken: "auth0-rt",
    });
    expect(open).toHaveBeenCalledOnce();
  });

  it("skips opening the browser when --no-browser is passed (still completes)", async () => {
    // Mirrors the OAuth flow above but exercises the `if (!options.noBrowser)`
    // false branch. We deliver the callback ourselves via setImmediate.
    delete process.env.CI;

    // Stash a pending callback fire — we extract the redirect_uri from the
    // ui.log.info line that runLogin prints. Easiest path is to monkey-
    // patch the native fetch so we observe the authorize URL build by way
    // of the loopback redirect: open is NOT called, so we instead arm a
    // delayed delivery via the cli/config fetch.
    let firedCallback = false;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [0],
          }),
          { status: 200 },
        );
      }
      if (url === "https://tenant.auth0.com/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "no-browser-at",
            refresh_token: "no-browser-rt",
            expires_in: 60,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Use a process.stdout.write spy to extract the authorize URL the SDK
    // logs — `ui.log.info("Browser: <url>")`. The state value is in there.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      writes.push(String(c));
      // As soon as we see the Browser: line, fire the callback fetch.
      const buf = writes.join("");
      const m = buf.match(/Browser: (https:\/\/[^\s]+)/);
      if (m && !firedCallback) {
        firedCallback = true;
        const parsed = new URL(m[1] as string);
        const state = parsed.searchParams.get("state");
        const redirect = parsed.searchParams.get("redirect_uri");
        setTimeout(() => {
          void ORIG_FETCH(`${redirect}?code=c&state=${state}`);
        }, 0);
      }
      return true;
    }) as typeof process.stdout.write;

    try {
      await runLogin({ oauth: true, noBrowser: true });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(open).not.toHaveBeenCalled();
    expect(await readCredentials()).toMatchObject({
      mode: "auth0",
      accessToken: "no-browser-at",
    });
  });

  it("rejects with a CSRF message when the callback state doesn't match the generated one", async () => {
    delete process.env.CI;
    vi.mocked(open).mockImplementation((async (url: string) => {
      const parsed = new URL(url);
      const redirect = parsed.searchParams.get("redirect_uri");
      // Deliberately wrong state value to trigger the CSRF guard.
      setTimeout(() => {
        void ORIG_FETCH(`${redirect}?code=c&state=mismatched-state`);
      }, 0);
      return undefined;
    }) as never);

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [0],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(runLogin({ oauth: true })).rejects.toThrow(
      /State mismatch.*CSRF/,
    );
    expect(await readCredentials()).toBeNull();
  });

  it("absorbs failures from `open` so the user can still copy the URL manually", async () => {
    // Branch coverage for the inner try/catch around `await open(url)`.
    delete process.env.CI;
    vi.mocked(open).mockImplementation((async (url: string) => {
      // Fire the callback (good path) but ALSO throw — the helper must
      // continue past the open failure and complete the flow.
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state");
      const redirect = parsed.searchParams.get("redirect_uri");
      setTimeout(() => {
        void ORIG_FETCH(`${redirect}?code=c&state=${state}`);
      }, 0);
      throw new Error("xdg-open not found");
    }) as never);

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [0],
          }),
          { status: 200 },
        );
      }
      if (url === "https://tenant.auth0.com/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "still-at",
            refresh_token: "still-rt",
            expires_in: 60,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runLogin({ oauth: true });
    expect(await readCredentials()).toMatchObject({
      mode: "auth0",
      accessToken: "still-at",
    });
  });
});
