import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentials,
  writeCredentials,
  credentialsPath,
  getToken,
  defaultArkorCloudApiUrl,
  requestAnonymousToken,
  type AnonymousCredentials,
  type Auth0Credentials,
} from "./credentials";
import { SDK_VERSION } from "./version";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
// `os.homedir()` reads HOME on POSIX but USERPROFILE on Windows. Setting only
// HOME redirects fakeHome on Linux/macOS but leaves Windows pointed at the
// real user profile, where tests would clobber a developer's actual
// `~/.arkor/credentials.json` and bleed state into sibling tests.
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;
const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-creds-test-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  // `process.env.X = undefined` writes the literal string "undefined" rather
  // than removing the entry, which then leaks into `os.homedir()` resolution
  // for any test that runs later in the same vitest worker. Match the
  // delete-when-originally-unset pattern used in cli/commands/*.test.ts.
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
  globalThis.fetch = ORIG_FETCH;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("credentials roundtrip", () => {
  it("returns null when no file exists", async () => {
    expect(await readCredentials()).toBeNull();
  });

  it("round-trips anon credentials and resolves under $HOME/.arkor", async () => {
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://localhost:3003",
      orgSlug: "anon-abc",
    };
    await writeCredentials(creds);
    expect(credentialsPath()).toBe(join(fakeHome, ".arkor", "credentials.json"));
    expect(await readCredentials()).toEqual(creds);
  });

  it("round-trips auth0 credentials", async () => {
    const creds: Auth0Credentials = {
      mode: "auth0",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1735000000,
      auth0Domain: "example.auth0.com",
      audience: "https://api.arkor.ai",
      clientId: "cid",
    };
    await writeCredentials(creds);
    expect(await readCredentials()).toEqual(creds);
  });
});

describe("getToken", () => {
  it("returns the anon token for anon mode", async () => {
    const token = await getToken({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://localhost",
      orgSlug: "anon-abc",
    });
    expect(token).toBe("anon-tok");
  });

  it("returns the access token for auth0 mode", async () => {
    const token = await getToken({
      mode: "auth0",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    expect(token).toBe("at");
  });
});

describe("defaultArkorCloudApiUrl", () => {
  it("prefers ARKOR_CLOUD_API_URL", () => {
    process.env.ARKOR_CLOUD_API_URL = "https://api.example.com/";
    expect(defaultArkorCloudApiUrl()).toBe("https://api.example.com");
  });
  it("falls back to https://api.arkor.ai", () => {
    delete process.env.ARKOR_CLOUD_API_URL;
    expect(defaultArkorCloudApiUrl()).toBe("https://api.arkor.ai");
  });
});

describe("requestAnonymousToken", () => {
  // Without X-Arkor-Client the cloud-api SDK version gate returns 426
  // reason=missing on /v1/auth/anonymous, which makes anonymous bootstrap
  // (and therefore `arkor dev` on a fresh install) impossible.
  it("sends X-Arkor-Client so the SDK version gate accepts the bootstrap call", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      captured = { url: String(input), init };
      return new Response(
        JSON.stringify({
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await requestAnonymousToken("http://mock-cloud-api", "cli");

    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url).toBe("http://mock-cloud-api/v1/auth/anonymous");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Arkor-Client")).toBe(`arkor/${SDK_VERSION}`);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("returns the parsed token shape", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await requestAnonymousToken(
      "http://mock-cloud-api",
      "cli",
    );
    expect(result).toEqual({
      token: "anon-tok",
      anonymousId: "anon-aid",
      kind: "cli",
      orgSlug: "anon-aid",
    });
  });

  it("throws with status and body snippet on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "sdk_version_unsupported", reason: "missing" }),
        { status: 426 },
      )) as typeof fetch;

    await expect(
      requestAnonymousToken("http://mock-cloud-api", "cli"),
    ).rejects.toThrow(/426/);
  });
});
