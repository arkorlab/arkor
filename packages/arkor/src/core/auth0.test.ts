import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  credentialsFromExchange,
  exchangeCode,
  generatePkce,
  fetchCliConfig,
  startLoopbackServer,
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

  it("persists `arkorCloudApiUrl` when supplied so SDK calls follow the auth-time host", () => {
    // `arkor login --oauth` passes the cloud API base URL it
    // authenticated against. Stamping it onto the persisted
    // credentials is what lets `defaultArkorCloudApiUrl(creds)` (and
    // therefore `runWhoami`, Studio, the SDK setup example) keep
    // talking to the same staging / self-hosted control plane on the
    // next run without `ARKOR_CLOUD_API_URL` re-set in the shell.
    const creds = credentialsFromExchange(
      {
        auth0Domain: "tenant.auth0.com",
        clientId: "abc",
        audience: "https://staging-api.arkor.ai",
        arkorCloudApiUrl: "https://staging-api.arkor.ai",
      },
      { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    );
    expect(creds.arkorCloudApiUrl).toBe("https://staging-api.arkor.ai");
  });

  it("omits `arkorCloudApiUrl` when not supplied (legacy / defensive call sites)", () => {
    // The persisted JSON shape stays minimal for older callers that
    // don't have the URL handy yet. Reading code falls through to the
    // production default in that case — see
    // `defaultArkorCloudApiUrl`.
    const creds = credentialsFromExchange(
      {
        auth0Domain: "tenant.auth0.com",
        clientId: "abc",
        audience: "https://api.arkor.ai",
      },
      { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    );
    expect(creds.arkorCloudApiUrl).toBeUndefined();
    expect("arkorCloudApiUrl" in creds).toBe(false);
  });

  it("preserves an explicitly empty `arkorCloudApiUrl` (config-error surface)", () => {
    // An operator who set `ARKOR_CLOUD_API_URL=""` to make config
    // errors fail loudly at first fetch should see that intent
    // round-trip through the persisted credentials. A truthy check
    // here would drop the field, and the next run's
    // `defaultArkorCloudApiUrl(creds)` would silently fall back to
    // production — exactly the masking the empty env var is set to
    // avoid.
    const creds = credentialsFromExchange(
      {
        auth0Domain: "tenant.auth0.com",
        clientId: "abc",
        audience: "https://api.arkor.ai",
        arkorCloudApiUrl: "",
      },
      { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    );
    expect(creds.arkorCloudApiUrl).toBe("");
    expect("arkorCloudApiUrl" in creds).toBe(true);
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

  it("strips a trailing slash from baseUrl", async () => {
    let captured = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(
        JSON.stringify({
          auth0Domain: null,
          clientId: null,
          audience: null,
          callbackPorts: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await fetchCliConfig("http://localhost:3003/", fetchImpl);
    expect(captured).toBe("http://localhost:3003/v1/auth/cli/config");
  });
});

describe("exchangeCode", () => {
  it("POSTs the PKCE code to Auth0 and returns the parsed token shape", async () => {
    let captured: { url: string; body: string } = { url: "", body: "" };
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = {
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      };
      return new Response(
        JSON.stringify({
          access_token: "at-token",
          refresh_token: "rt-token",
          id_token: "id-token",
          expires_in: 7200,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await exchangeCode(
      { auth0Domain: "tenant.auth0.com", clientId: "client-id" },
      {
        code: "auth-code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:52521/callback",
      },
      fetchImpl,
    );

    expect(captured.url).toBe("https://tenant.auth0.com/oauth/token");
    const body = JSON.parse(captured.body) as Record<string, string>;
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("auth-code");
    expect(body.code_verifier).toBe("verifier");
    expect(body.client_id).toBe("client-id");
    expect(body.redirect_uri).toBe("http://127.0.0.1:52521/callback");

    expect(res).toEqual({
      accessToken: "at-token",
      refreshToken: "rt-token",
      idToken: "id-token",
      expiresIn: 7200,
    });
  });

  it("throws with the upstream body when Auth0 rejects the exchange", async () => {
    const fetchImpl = (async () =>
      new Response("invalid_grant", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode(
        { auth0Domain: "tenant.auth0.com", clientId: "c" },
        {
          code: "bad",
          codeVerifier: "v",
          redirectUri: "http://127.0.0.1/callback",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/token exchange failed.*400.*invalid_grant/);
  });

  it("throws when Auth0 omits the refresh token (offline_access scope missing)", async () => {
    // The offline_access scope is what causes Auth0 to issue a refresh
    // token. Forgetting it on the Application registration is a common
    // setup mistake — surface the actionable hint loudly rather than
    // limping along with no refresh capability.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: "at",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as typeof fetch;
    await expect(
      exchangeCode(
        { auth0Domain: "tenant.auth0.com", clientId: "c" },
        {
          code: "x",
          codeVerifier: "v",
          redirectUri: "http://127.0.0.1/callback",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/offline_access/);
  });
});

describe("startLoopbackServer", () => {
  // Each subtest closes the server in a finally so a stray bind doesn't
  // hold up vitest's worker shutdown on Linux.

  it("resolves the callback promise with code + state when the redirect lands", async () => {
    const result = await startLoopbackServer([0]);
    // Mirror the unhandled-rejection guard used by the negative tests so
    // this case can't fall over if a future regression turns the success
    // path into a reject.
    const callback = result.waitForCallback;
    try {
      const res = await fetch(
        `http://127.0.0.1:${result.port}/callback?code=auth-code&state=state-val`,
      );
      expect(res.status).toBe(200);
      expect(await callback).toEqual({ code: "auth-code", state: "state-val" });
    } finally {
      result.server.close();
    }
  });

  it("rejects the callback promise when the redirect carries an OAuth error", async () => {
    const result = await startLoopbackServer([0]);
    // Attach the rejection handler BEFORE triggering the fetch so the
    // promise rejection inside the request handler is never seen as
    // unhandled by vitest's worker.
    const callback = result.waitForCallback.catch((e: unknown) => e);
    try {
      const res = await fetch(
        `http://127.0.0.1:${result.port}/callback?error=access_denied&error_description=user%20cancelled`,
      );
      expect(res.status).toBe(400);
      const err = await callback;
      expect((err as Error).message).toMatch(/access_denied/);
    } finally {
      result.server.close();
    }
  });

  it("falls back to an empty error_description when the param is omitted", async () => {
    // Branch coverage for `errorDescription ?? ""` (twice on the error
    // path). Auth0 always sends a description for known errors but we've
    // seen custom proxies strip query params; the fallback keeps the
    // response well-formed.
    const result = await startLoopbackServer([0]);
    const callback = result.waitForCallback.catch((e: unknown) => e);
    try {
      const res = await fetch(
        `http://127.0.0.1:${result.port}/callback?error=server_error`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      // The trailing ` — ` is preserved before the empty description so
      // a regression that drops the separator surfaces here.
      expect(body).toContain("Authentication failed: server_error — ");
      const err = await callback;
      expect((err as Error).message).toMatch(/server_error/);
    } finally {
      result.server.close();
    }
  });

  it("serves the error page as text/plain with nosniff so reflected query params can't be rendered as HTML", async () => {
    // Reflected-XSS guard: `error` and `error_description` are pulled
    // straight off the query string into the response body. Without an
    // explicit Content-Type browsers MIME-sniff and would render any
    // HTML payload, giving an attacker who can lure a user to a crafted
    // /callback URL during `arkor login` script execution against the
    // loopback origin. The server must commit to text/plain and disable
    // sniffing so the payload round-trips as literal text.
    const result = await startLoopbackServer([0]);
    const callback = result.waitForCallback.catch((e: unknown) => e);
    try {
      const payload = "<script>alert(1)</script>";
      const res = await fetch(
        `http://127.0.0.1:${result.port}/callback?error=server_error&error_description=${encodeURIComponent(payload)}`,
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(
        /^text\/plain;\s*charset=utf-8$/i,
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await res.text();
      // Payload must round-trip literally — not HTML-escaped (text/plain
      // already neutralises it) and not stripped.
      expect(body).toContain(payload);
      await callback;
    } finally {
      result.server.close();
    }
  });

  it("rejects the callback promise when code or state is missing", async () => {
    const result = await startLoopbackServer([0]);
    const callback = result.waitForCallback.catch((e: unknown) => e);
    try {
      const res = await fetch(
        `http://127.0.0.1:${result.port}/callback?code=only`,
      );
      expect(res.status).toBe(400);
      const err = await callback;
      expect((err as Error).message).toMatch(/Missing code\/state/);
    } finally {
      result.server.close();
    }
  });

  it("returns 404 for paths other than /callback (and does not resolve the callback)", async () => {
    const result = await startLoopbackServer([0]);
    // Pre-attach a no-op handler so the still-pending promise doesn't
    // turn into a stray unhandled rejection on test shutdown.
    result.waitForCallback.catch(() => undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${result.port}/`);
      expect(res.status).toBe(404);

      // The callback promise is still pending — `waitForCallback` only
      // resolves on a real /callback hit.
      const sentinel = Symbol("pending");
      const winner = await Promise.race([
        result.waitForCallback,
        new Promise((r) => setTimeout(() => r(sentinel), 30)),
      ]);
      expect(winner).toBe(sentinel);
    } finally {
      result.server.close();
    }
  });

  it("falls through to the next port when the first is busy", async () => {
    // Hold port 0-bound first to capture an actual port number, then start
    // a second loopback that's told to try (busyPort, 0). It must skip the
    // busy one and bind on the fallback.
    const busy = await startLoopbackServer([0]);
    busy.waitForCallback.catch(() => undefined);
    try {
      const fallback = await startLoopbackServer([busy.port, 0]);
      fallback.waitForCallback.catch(() => undefined);
      try {
        expect(fallback.port).not.toBe(busy.port);
      } finally {
        fallback.server.close();
      }
    } finally {
      busy.server.close();
    }
  });

  it("throws when none of the requested ports can be bound", async () => {
    // Hold an ephemeral port to guarantee an EADDRINUSE on the second
    // bind attempt — relying on the unprivileged-port (port 1) trick is
    // not portable (root containers, BSD permission models). The error
    // message must include all attempted ports so the user can update
    // the Auth0 Allowed Callback URLs.
    const busy = await startLoopbackServer([0]);
    busy.waitForCallback.catch(() => undefined);
    try {
      await expect(startLoopbackServer([busy.port])).rejects.toThrow(
        new RegExp(
          `Unable to bind any of the loopback ports ${busy.port}`,
        ),
      );
    } finally {
      busy.server.close();
    }
  });
});
