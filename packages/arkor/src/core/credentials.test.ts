import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  defaultArkorCloudApiUrl,
  ensureCredentials,
  getToken,
  readCredentials,
  requestAnonymousToken,
  studioTokenPath,
  writeCredentials,
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
  it("propagates an explicitly-empty ARKOR_CLOUD_API_URL (config-error surface)", () => {
    // `arkor dev`'s startup test relies on `""` reaching the URL parser
    // so a misconfigured env throws at startup instead of silently
    // falling through to the production endpoint. The env wins over
    // both the production fallback and any credentials-derived URL.
    process.env.ARKOR_CLOUD_API_URL = "";
    expect(defaultArkorCloudApiUrl()).toBe("");
  });
  it("derives baseUrl from anonymous credentials when env is unset", () => {
    // `CloudApiClient` requires an explicit `baseUrl`. OAuth
    // credentials don't carry one; anonymous credentials do, captured
    // at signup against whatever cloud the token was issued by. This
    // lets a script reuse `readCredentials()` to talk to the same
    // staging / self-hosted endpoint the user authenticated against.
    delete process.env.ARKOR_CLOUD_API_URL;
    const url = defaultArkorCloudApiUrl({
      mode: "anon",
      token: "t",
      anonymousId: "a",
      arkorCloudApiUrl: "https://staging.arkor.ai/",
      orgSlug: "anon-x",
    });
    expect(url).toBe("https://staging.arkor.ai");
  });
  it("falls back to production for OAuth credentials (no baseUrl in token)", () => {
    delete process.env.ARKOR_CLOUD_API_URL;
    const url = defaultArkorCloudApiUrl({
      mode: "auth0",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    expect(url).toBe("https://api.arkor.ai");
  });
  it("env wins over credentials-derived URL", () => {
    // Operator override stays authoritative — useful for pointing a
    // production-credentials script at a staging mirror for a one-off
    // debug session without re-issuing the token.
    process.env.ARKOR_CLOUD_API_URL = "https://override.example.com";
    const url = defaultArkorCloudApiUrl({
      mode: "anon",
      token: "t",
      anonymousId: "a",
      arkorCloudApiUrl: "https://staging.arkor.ai",
      orgSlug: "anon-x",
    });
    expect(url).toBe("https://override.example.com");
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

  it("falls back to an empty body snippet when reading the response text throws", async () => {
    // Branch coverage for the `.catch(() => "")` defensive arm — a
    // proxied response whose body errors mid-read shouldn't crash the
    // bootstrap with a confusing TypeError instead of a clean
    // AnonymousTokenRejectedError.
    globalThis.fetch = (async () => {
      const body = new ReadableStream({
        start(c) {
          c.error(new Error("body broke mid-flight"));
        },
      });
      return new Response(body, { status: 503 });
    }) as typeof fetch;

    await expect(
      requestAnonymousToken("http://mock-cloud-api", "cli"),
    ).rejects.toThrow(/503/);
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

describe("studioTokenPath", () => {
  it("resolves under the same directory as credentialsPath()", () => {
    // The token must live next to credentials.json so the SPA's middleware
    // can find it via the same `~/.arkor` lookup the CLI uses.
    expect(studioTokenPath()).toBe(join(fakeHome, ".arkor", "studio-token"));
  });
});

describe("ensureCredentials", () => {
  it("returns the existing credentials without bootstrapping", async () => {
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "existing",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-abc",
    };
    await writeCredentials(creds);

    // No fetch mock — the function must early-return without calling out.
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    expect(await ensureCredentials()).toEqual(creds);
  });

  it("bootstraps a fresh anonymous identity, persists it, and returns the parsed shape", async () => {
    // No credentials file exists (fakeHome was just mkdtemp'd in beforeEach).
    process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api/";
    const seenUrls: string[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
    ) => {
      seenUrls.push(String(input));
      return new Response(
        JSON.stringify({
          token: "fresh-tok",
          anonymousId: "fresh-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "fresh-aid", name: "Anon" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const creds = await ensureCredentials();

    // Trailing slash on ARKOR_CLOUD_API_URL is stripped by defaultArkorCloudApiUrl,
    // so the captured URL has no double slash and the persisted baseUrl
    // round-trips cleanly.
    expect(seenUrls).toEqual(["http://mock-cloud-api/v1/auth/anonymous"]);

    expect(creds).toEqual({
      mode: "anon",
      token: "fresh-tok",
      anonymousId: "fresh-aid",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "fresh-aid",
    });

    // The bootstrapped credentials are persisted to disk for reuse.
    expect(await readCredentials()).toEqual(creds);
  });

  it("rethrows when the anonymous endpoint refuses to issue a token", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "anonymous disabled" }), {
        status: 403,
      })) as typeof fetch;
    await expect(ensureCredentials()).rejects.toThrow(/403/);
    expect(await readCredentials()).toBeNull();
  });
});
