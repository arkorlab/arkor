import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Auth0Credentials } from "./credentials";

export interface CliConfig {
  auth0Domain: string | null;
  clientId: string | null;
  audience: string | null;
  callbackPorts: number[];
}

/**
 * Fetch the arkor-cloud-api deployment's CLI config. Needed before starting
 * the PKCE flow so the CLI learns the Auth0 tenant + client id without env
 * vars on the user's machine.
 */
export async function fetchCliConfig(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CliConfig> {
  const res = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/v1/auth/cli/config`,
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch CLI config from ${baseUrl} (${res.status})`,
    );
  }
  return (await res.json()) as CliConfig;
}

export interface PkceMaterial {
  verifier: string;
  challenge: string;
  state: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generatePkce(): PkceMaterial {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));
  return { verifier, challenge, state };
}

export interface LoopbackServerResult {
  server: Server;
  port: number;
  /** Resolves with the `{ code, state }` from the OAuth redirect. */
  waitForCallback: Promise<{ code: string; state: string }>;
}

/**
 * Bind a loopback HTTP server on the first available port from `ports`.
 * Callers must close `server` after use (the flow does so in `runPkceLogin`).
 */
export async function startLoopbackServer(
  ports: number[],
): Promise<LoopbackServerResult> {
  let lastError: unknown;
  for (const port of ports) {
    try {
      return await bindOnPort(port);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Unable to bind any of the loopback ports ${ports.join(
      ", ",
    )}. The Auth0 Application must list at least one of these as an Allowed Callback URL: ${lastError}`,
  );
}

function bindOnPort(port: number): Promise<LoopbackServerResult> {
  return new Promise((resolve, reject) => {
    let resolveCallback: (v: { code: string; state: string }) => void;
    let rejectCallback: (err: Error) => void;
    const waitForCallback = new Promise<{ code: string; state: string }>(
      (res, rej) => {
        resolveCallback = res;
        rejectCallback = rej;
      },
    );

    const sendPlain = (
      res: ServerResponse,
      status: number,
      body: string,
    ) => {
      res.statusCode = status;
      // text/plain + nosniff: the error path reflects user-controlled
      // `error` / `error_description` query params, so we must defeat
      // browser MIME sniffing to prevent reflected XSS on the loopback origin.
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(body);
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        sendPlain(res, 404, "Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        sendPlain(
          res,
          400,
          `Authentication failed: ${error}: ${errorDescription ?? ""}`,
        );
        rejectCallback(
          new Error(`Authentication failed: ${error} ${errorDescription ?? ""}`),
        );
        return;
      }
      if (!code || !state) {
        sendPlain(res, 400, "Missing code/state");
        rejectCallback(new Error("Missing code/state in callback"));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><title>arkor CLI</title><body style="font-family:system-ui;padding:40px">` +
          `<h1>Signed in to arkor</h1><p>You can close this tab and return to the terminal.</p>` +
          `</body>`,
      );
      resolveCallback({ code, state });
    });

    server.once("error", (err) => reject(err));
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      resolve({
        server,
        port: addr?.port ?? port,
        waitForCallback,
      });
    });
  });
}

export interface ExchangeCodeResult {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn: number;
}

export async function exchangeCode(
  config: { auth0Domain: string; clientId: string },
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeCodeResult> {
  const res = await fetchImpl(`https://${config.auth0Domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: config.clientId,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Auth0 token exchange failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  if (!body.refresh_token) {
    throw new Error(
      "Auth0 did not return a refresh token. Make sure the Application has 'offline_access' scope enabled.",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    expiresIn: body.expires_in,
  };
}

export function buildAuthorizeUrl(
  config: { auth0Domain: string; clientId: string; audience: string },
  input: { redirectUri: string; state: string; challenge: string; scopes?: string[] },
): string {
  const scopes = input.scopes ?? [
    "openid",
    "profile",
    "email",
    "offline_access",
  ];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    scope: scopes.join(" "),
    audience: config.audience,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return `https://${config.auth0Domain}/authorize?${params.toString()}`;
}

export function credentialsFromExchange(
  config: { auth0Domain: string; clientId: string; audience: string },
  exchange: ExchangeCodeResult,
): Auth0Credentials {
  return {
    mode: "auth0",
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + exchange.expiresIn,
    auth0Domain: config.auth0Domain,
    audience: config.audience,
    clientId: config.clientId,
  };
}
