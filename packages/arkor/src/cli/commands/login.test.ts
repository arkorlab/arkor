import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as clack from "@clack/prompts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "./login";
import { readCredentials } from "../../core/credentials";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
const ORIG_CI = process.env.CI;
const ORIG_FETCH = globalThis.fetch;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-login-test-"));
  process.env.HOME = fakeHome;
  process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
  // Force isInteractive() → false so promptSelect returns its initialValue
  // instead of trying to open a real clack prompt.
  process.env.CI = "1";
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
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
});
