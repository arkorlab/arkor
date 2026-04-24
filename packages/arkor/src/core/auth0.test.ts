import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  credentialsFromExchange,
  generatePkce,
  fetchCliConfig,
} from "./auth0";

describe("generatePkce", () => {
  it("produces URL-safe base64 values", () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.challenge.length).toBe(43);
  });

  it("produces fresh values each call", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe("buildAuthorizeUrl", () => {
  it("emits an Auth0-compatible URL with all required parameters", () => {
    const url = buildAuthorizeUrl(
      {
        auth0Domain: "tenant.auth0.com",
        clientId: "abc123",
        audience: "https://api.arkor.ai",
      },
      {
        redirectUri: "http://127.0.0.1:52521/callback",
        state: "stateval",
        challenge: "challengeval",
      },
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://tenant.auth0.com");
    expect(parsed.pathname).toBe("/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("abc123");
    expect(parsed.searchParams.get("audience")).toBe("https://api.arkor.ai");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:52521/callback",
    );
    expect(parsed.searchParams.get("scope")).toBe(
      "openid profile email offline_access",
    );
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("stateval");
    expect(parsed.searchParams.get("code_challenge")).toBe("challengeval");
  });
});

describe("credentialsFromExchange", () => {
  it("wraps the token response in Auth0Credentials shape", () => {
    const creds = credentialsFromExchange(
      {
        auth0Domain: "tenant.auth0.com",
        clientId: "abc",
        audience: "https://api.arkor.ai",
      },
      { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    );
    expect(creds.mode).toBe("auth0");
    expect(creds.accessToken).toBe("at");
    expect(creds.refreshToken).toBe("rt");
    expect(creds.auth0Domain).toBe("tenant.auth0.com");
    expect(creds.clientId).toBe("abc");
    expect(creds.audience).toBe("https://api.arkor.ai");
    // expiresAt is now + 3600s (accept ±2s of wall drift)
    const now = Math.floor(Date.now() / 1000);
    expect(creds.expiresAt).toBeGreaterThanOrEqual(now + 3598);
    expect(creds.expiresAt).toBeLessThanOrEqual(now + 3602);
  });
});

describe("fetchCliConfig", () => {
  it("parses the cloud-api response", async () => {
    const payload = {
      auth0Domain: "tenant.auth0.com",
      clientId: "abc",
      audience: "https://api.arkor.ai",
      callbackPorts: [52521, 52522],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const cfg = await fetchCliConfig("http://localhost:3003", fetchImpl);
    expect(cfg).toEqual(payload);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    await expect(
      fetchCliConfig("http://localhost:3003", fetchImpl),
    ).rejects.toThrow(/Failed to fetch CLI config/);
  });
});
