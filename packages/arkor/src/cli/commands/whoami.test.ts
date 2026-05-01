import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentials } from "../../core/credentials";
import { runWhoami } from "./whoami";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
// Node's `os.homedir()` reads HOME on POSIX but USERPROFILE (and falls
// back to HOMEDRIVE+HOMEPATH) on Windows, so HOME alone doesn't keep
// the credential helpers' file IO inside a temp dir on Windows. Capture
// all four so afterEach can restore the originals cleanly.
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOMEDRIVE = process.env.HOMEDRIVE;
const ORIG_HOMEPATH = process.env.HOMEPATH;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;
const ORIG_FETCH = globalThis.fetch;
const ORIG_EXIT_CODE = process.exitCode;
const ORIG_UA = process.env.npm_config_user_agent;

let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-whoami-test-"));
  process.env.HOME = fakeHome;
  // Mirror HOME into the Windows home-dir env vars so `os.homedir()`
  // — and therefore the credential helpers — point at the temp dir on
  // every platform.
  process.env.USERPROFILE = fakeHome;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = fakeHome;
  process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
  // Pin the detected pm so 426 messages are deterministic across machines.
  process.env.npm_config_user_agent = "pnpm/10 node/v22 linux x64";

  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIG_HOMEDRIVE !== undefined) process.env.HOMEDRIVE = ORIG_HOMEDRIVE;
  else delete process.env.HOMEDRIVE;
  if (ORIG_HOMEPATH !== undefined) process.env.HOMEPATH = ORIG_HOMEPATH;
  else delete process.env.HOMEPATH;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
  if (ORIG_UA !== undefined) process.env.npm_config_user_agent = ORIG_UA;
  else delete process.env.npm_config_user_agent;
  globalThis.fetch = ORIG_FETCH;
  process.exitCode = ORIG_EXIT_CODE;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("runWhoami", () => {
  it("prints a sign-in hint and bails when no credentials exist", async () => {
    // Hit the early-return: no fetch should be called.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    await runWhoami();
    const out = stdoutChunks.join("");
    expect(out).toMatch(/Not signed in/);
    expect(out).toMatch(/arkor login --anonymous/);
    expect(process.exitCode).not.toBe(1);
  });

  it("renders the user JSON and orgs slug list on 200", async () => {
    await writeCredentials({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/me")) {
        return new Response(
          JSON.stringify({
            user: { id: "u1", email: "a@b.test" },
            orgs: [
              { id: "o1", slug: "anon-abc", name: "Anon" },
              { id: "o2", slug: "team", name: "Team" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runWhoami();
    const out = stdoutChunks.join("");
    // The user object is pretty-printed.
    expect(out).toContain('"id": "u1"');
    expect(out).toContain('"email": "a@b.test"');
    // Orgs render with comma-joined slugs.
    expect(out).toMatch(/Orgs: anon-abc, team/);
    expect(process.exitCode).not.toBe(1);
  });

  it("omits the orgs line when /v1/me returns an empty list", async () => {
    await writeCredentials({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: { id: "u" }, orgs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    await runWhoami();
    const out = stdoutChunks.join("");
    expect(out).toContain('"id": "u"');
    expect(out).not.toMatch(/Orgs:/);
  });

  it("blocks with exit code 1 + structured upgrade hint on 426", async () => {
    await writeCredentials({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "sdk_version_unsupported",
            currentVersion: "1.3.5",
            supportedRange: "^1.4.0 || >=2.1.0",
            upgrade: "npm install -g arkor@latest",
          }),
          {
            status: 426,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as typeof fetch;

    await runWhoami();

    const err = stderrChunks.join("");
    expect(err).toMatch(/1\.3\.5 is no longer supported/);
    expect(err).toMatch(/\^1\.4\.0 \|\| >=2\.1\.0/);
    // Detected pm overrides body.upgrade.
    expect(err).toContain("pnpm add -g arkor@latest");
    expect(process.exitCode).toBe(1);
  });

  it("falls back to a generic upgrade message on 426 with non-JSON body", async () => {
    // A mis-configured deployment may serve `text/html` for 426 errors.
    // The fallback in `formatSdkUpgradeError` must still produce something
    // actionable so the user isn't left wondering why whoami failed.
    await writeCredentials({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>upgrade required</html>", {
          status: 426,
          headers: { "content-type": "text/html" },
        }),
    ) as typeof fetch;

    await runWhoami();
    const err = stderrChunks.join("");
    expect(err).toMatch(/Arkor SDK is no longer supported/);
    expect(err).toContain("pnpm add -g arkor@latest");
    expect(process.exitCode).toBe(1);
  });

  it("uses the Auth0 access token in the bearer header (auth0 mode)", async () => {
    // Branch coverage for `creds.mode === "anon" ? creds.token : creds.accessToken`.
    // The token closure runs lazily on the first request, so the spy must
    // observe the auth0-specific token reaching /v1/me.
    await writeCredentials({
      mode: "auth0",
      accessToken: "auth0-at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "tenant.auth0.com",
      audience: "https://api.arkor.ai",
      clientId: "cid",
    });
    let capturedAuth = "";
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/me")) {
        capturedAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({ user: { id: "u-auth0" }, orgs: [] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runWhoami();
    expect(capturedAuth).toBe("Bearer auth0-at");
  });

  it("falls back to org id when an org has no slug", async () => {
    // Branch coverage for `o.slug ?? o.id` — historic data may have orgs
    // without a slug column populated; the helper must still render
    // something rather than `undefined`.
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: "u" },
            orgs: [{ id: "o-without-slug" }, { slug: "named", id: "x" }],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    await runWhoami();
    const out = stdoutChunks.join("");
    expect(out).toMatch(/Orgs: o-without-slug, named/);
  });

  it("prints a 'token may be expired' hint on other non-2xx without setting exitCode", async () => {
    await writeCredentials({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
    });
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 401 }),
    ) as typeof fetch;

    await runWhoami();
    const out = stdoutChunks.join("");
    expect(out).toMatch(/Failed to fetch \/v1\/me \(401\)/);
    expect(out).toMatch(/Token may be expired/);
    // Distinct from the 426 path: no hard block on auth failures, just a
    // hint, so the deprecation flush in main.ts can still run.
    expect(process.exitCode).not.toBe(1);
  });
});
