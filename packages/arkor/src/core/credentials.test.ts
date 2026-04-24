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
  type AnonymousCredentials,
  type Auth0Credentials,
} from "./credentials";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-creds-test-"));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
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
  it("falls back to localhost:3003", () => {
    delete process.env.ARKOR_CLOUD_API_URL;
    expect(defaultArkorCloudApiUrl()).toBe("http://localhost:3003");
  });
});
