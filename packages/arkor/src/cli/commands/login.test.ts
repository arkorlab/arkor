import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  process.env.HOME = ORIG_HOME;
  if (ORIG_CI !== undefined) process.env.CI = ORIG_CI;
  else delete process.env.CI;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
  globalThis.fetch = ORIG_FETCH;
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
});
