import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  type OAuthCredentials,
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
  if (ORIG_USERPROFILE !== undefined)
    process.env.USERPROFILE = ORIG_USERPROFILE;
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
    expect(credentialsPath()).toBe(
      join(fakeHome, ".arkor", "credentials.json"),
    );
    expect(await readCredentials()).toEqual(creds);
  });

  it("round-trips oauth credentials", async () => {
    const creds: OAuthCredentials = {
      mode: "oauth",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_735_000_000,
      auth0Domain: "example.auth0.com",
      audience: "https://api.arkor.ai",
      clientId: "cid",
    };
    await writeCredentials(creds);
    expect(await readCredentials()).toEqual(creds);
  });

  // ENG-933: a truncated / hand-mangled credentials.json used to make every
  // `arkor` command die with a raw SyntaxError. It must now be treated like a
  // missing file (returns null, silently) so callers re-bootstrap cleanly; the
  // one-time warning lives in ensureCredentials, not here.
  it("returns null (does not throw, stays silent) on a corrupt credentials.json", async () => {
    mkdirSync(join(fakeHome, ".arkor"), { recursive: true });
    // Simulate a crash mid-write: truncated JSON.
    writeFileSync(credentialsPath(), '{ "mode": "oauth", "accessTok');
    // readCredentials must NOT warn: it is on the always-on telemetry path,
    // so the "unreadable" notice lives in ensureCredentials instead.
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await expect(readCredentials()).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // A present-but-unreadable file must NOT be reported as missing: a valid but
  // temporarily-unreadable OAuth login (EACCES/EIO/EISDIR) must rethrow so
  // ensureCredentials never overwrites it with an anonymous identity. EISDIR
  // (path is a directory) is the deterministic, non-root-bypassable stand-in.
  it("rethrows (does not return null) when the credentials path is present but unreadable", async () => {
    mkdirSync(credentialsPath(), { recursive: true });
    await expect(readCredentials()).rejects.toThrow();
  });

  // Atomic write: no stray `credentials.json.<pid>.<uuid>.tmp` left behind, and the
  // final file is the fully-written JSON (never a partial).
  it("writes atomically and leaves no temp file behind", async () => {
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://localhost",
      orgSlug: "anon-abc",
    };
    await writeCredentials(creds);
    const dir = join(fakeHome, ".arkor");
    const strays = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(strays).toEqual([]);
    expect(await readCredentials()).toEqual(creds);
  });

  // Covers the `catch { await rm(tmp) }` cleanup branch: when the atomic
  // rename fails, the staged temp file must be removed and the error must
  // propagate (never leave a stray `credentials.json.<pid>.tmp`).
  it("cleans up the temp file and rejects when the rename fails", async () => {
    // Force rename(tmp, path) to fail by making the target path a directory
    // (rename of a file over a directory fails on every platform).
    mkdirSync(credentialsPath(), { recursive: true });
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "tok",
      anonymousId: "abc",
      arkorCloudApiUrl: "http://localhost",
      orgSlug: "anon-abc",
    };
    await expect(writeCredentials(creds)).rejects.toThrow();
    const dir = join(fakeHome, ".arkor");
    const strays = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(strays).toEqual([]);
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

  it("returns the access token for oauth mode", async () => {
    const token = await getToken({
      mode: "oauth",
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
  it("strips multiple trailing slashes from the env-var value", () => {
    // Defends against a misconfigured `ARKOR_CLOUD_API_URL` like
    // `https://host///` collapsing to `https://host/` and producing
    // double-slash request URLs (`https://host//v1/me`) downstream.
    process.env.ARKOR_CLOUD_API_URL = "https://api.example.com////";
    expect(defaultArkorCloudApiUrl()).toBe("https://api.example.com");
  });
  it("strips multiple trailing slashes from a credentials-derived URL", () => {
    // Same hazard as above, but for the URL persisted on a credentials
    // record (e.g. an anonymous bootstrap that captured a sloppy host).
    delete process.env.ARKOR_CLOUD_API_URL;
    expect(
      defaultArkorCloudApiUrl({
        mode: "anon",
        token: "t",
        anonymousId: "a",
        arkorCloudApiUrl: "https://staging.arkor.ai///",
        orgSlug: "anon-x",
      }),
    ).toBe("https://staging.arkor.ai");
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
  it("falls back to production for legacy OAuth credentials with no baseUrl", () => {
    // Credentials persisted before `OAuthCredentials.arkorCloudApiUrl`
    // was added (round 67). The graceful fallback is production:
    // operators on staging / self-hosted who hit this would have to
    // re-run `arkor login` to repopulate the field, or set
    // `ARKOR_CLOUD_API_URL` to bridge.
    delete process.env.ARKOR_CLOUD_API_URL;
    const url = defaultArkorCloudApiUrl({
      mode: "oauth",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    expect(url).toBe("https://api.arkor.ai");
  });
  it("derives baseUrl from OAuth credentials when arkorCloudApiUrl is present", () => {
    // `arkor login` writes `arkorCloudApiUrl` into the credentials so
    // subsequent SDK calls keep targeting the same control plane.
    delete process.env.ARKOR_CLOUD_API_URL;
    const url = defaultArkorCloudApiUrl({
      mode: "oauth",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
      arkorCloudApiUrl: "https://staging-api.arkor.ai/",
    });
    expect(url).toBe("https://staging-api.arkor.ai");
  });
  it("propagates an explicitly-empty arkorCloudApiUrl on credentials (config-error surface)", () => {
    // Mirror of the env-var case above: an operator who logged in
    // with `ARKOR_CLOUD_API_URL=""` to make config errors fail
    // loudly should see that intent round-trip through the persisted
    // credentials and back out via this helper, *not* be silently
    // substituted with production. The OAuth login path stamps the
    // empty string verbatim into `OAuthCredentials.arkorCloudApiUrl`,
    // and this helper has to honour it.
    delete process.env.ARKOR_CLOUD_API_URL;
    const url = defaultArkorCloudApiUrl({
      mode: "oauth",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
      arkorCloudApiUrl: "",
    });
    expect(url).toBe("");
  });
  it("env wins over credentials-derived URL", () => {
    // Operator override stays authoritative: useful for pointing a
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
      return Response.json(
        {
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        },
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
      Response.json(
        {
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        },
        { status: 200 },
      )) as typeof fetch;

    const result = await requestAnonymousToken("http://mock-cloud-api", "cli");
    expect(result).toEqual({
      token: "anon-tok",
      anonymousId: "anon-aid",
      kind: "cli",
      orgSlug: "anon-aid",
    });
  });

  it("falls back to an empty body snippet when reading the response text throws", async () => {
    // Branch coverage for the `.catch(() => "")` defensive arm: a
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
      Response.json(
        { error: "sdk_version_unsupported", reason: "missing" },
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

    // No fetch mock: the function must early-return without calling out.
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    expect(await ensureCredentials()).toEqual(creds);
  });

  it("warns once and re-bootstraps when the existing credentials file has corrupt content", async () => {
    // Corrupt JSON content (not an I/O error) is safe to replace. The warning
    // lives here (the explicit bootstrap path), NOT in the always-on
    // readCredentials/telemetry path, so it surfaces exactly once.
    mkdirSync(join(fakeHome, ".arkor"), { recursive: true });
    writeFileSync(credentialsPath(), "{ truncated");
    process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
    globalThis.fetch = (async () =>
      Response.json(
        {
          token: "fresh-tok",
          anonymousId: "fresh-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "fresh-aid", name: "Anon" },
        },
        { status: 200 },
      )) as typeof fetch;
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const creds = await ensureCredentials();
      expect(creds).toMatchObject({ mode: "anon", token: "fresh-tok" });
      const replaceWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("could not be parsed and is being replaced"),
      );
      expect(replaceWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Data-loss regression guard (ENG-933 round-5 finding): a present-but-
  // unreadable credentials file may hold a valid OAuth login. ensureCredentials
  // must NOT bootstrap over it (no anonymous token request, no overwrite); it
  // must surface the read error so the file is preserved.
  it("does not overwrite a present-but-unreadable credentials file", async () => {
    // EISDIR: credentials.json is a directory -> readCredentials rethrows.
    mkdirSync(credentialsPath(), { recursive: true });
    const fetchSpy = vi.fn(async () => {
      throw new Error("anonymous bootstrap must not be attempted");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(ensureCredentials()).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The path is untouched (still the directory we created, never replaced).
    expect(existsSync(credentialsPath())).toBe(true);
  });

  it("bootstraps a fresh anonymous identity, persists it, and returns the parsed shape", async () => {
    // No credentials file exists (fakeHome was just mkdtemp'd in beforeEach).
    process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api/";
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seenUrls.push(String(input));
      return Response.json(
        {
          token: "fresh-tok",
          anonymousId: "fresh-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "fresh-aid", name: "Anon" },
        },
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
      Response.json(
        { error: "anonymous disabled" },
        {
          status: 403,
        },
      )) as typeof fetch;
    await expect(ensureCredentials()).rejects.toThrow(/403/);
    expect(await readCredentials()).toBeNull();
  });
});
