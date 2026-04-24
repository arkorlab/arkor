import open from "open";
import {
  buildAuthorizeUrl,
  credentialsFromExchange,
  exchangeCode,
  fetchCliConfig,
  generatePkce,
  startLoopbackServer,
} from "../../core/auth0";
import {
  defaultArkorCloudApiUrl,
  writeCredentials,
  type AnonymousCredentials,
} from "../../core/credentials";
import { acquireAnonymousTokenResult } from "../anonymous";
import { ui } from "../prompts";

export interface LoginOptions {
  anonymous?: boolean;
  /** Skip opening the browser (prints the URL instead). Useful for headless environments. */
  noBrowser?: boolean;
}

export async function runLogin(options: LoginOptions = {}): Promise<void> {
  if (options.anonymous) {
    await runAnonymousLogin();
    return;
  }

  const baseUrl = defaultArkorCloudApiUrl();
  const cfg = await fetchCliConfig(baseUrl);
  if (!cfg.auth0Domain || !cfg.clientId || !cfg.audience) {
    ui.log.info(
      "Auth0 is not configured — continuing with an anonymous session.",
    );
    await runAnonymousLogin();
    return;
  }

  await runAuth0Login(
    {
      auth0Domain: cfg.auth0Domain,
      clientId: cfg.clientId,
      audience: cfg.audience,
      callbackPorts: cfg.callbackPorts,
    },
    options,
  );
}

async function runAnonymousLogin(): Promise<void> {
  const baseUrl = defaultArkorCloudApiUrl();
  const spin = ui.spinner();
  spin.start("Requesting anonymous token");
  const result = await acquireAnonymousTokenResult(baseUrl);
  const creds: AnonymousCredentials = {
    mode: "anon",
    token: result.token,
    anonymousId: result.anonymousId,
    arkorCloudApiUrl: baseUrl,
    orgSlug: result.orgSlug,
  };
  await writeCredentials(creds);
  spin.stop(`Anonymous id: ${result.anonymousId}`);
  ui.log.success(`Signed in anonymously (personal org: ${result.orgSlug}).`);
}

interface ResolvedCliConfig {
  auth0Domain: string;
  clientId: string;
  audience: string;
  callbackPorts: number[];
}

async function runAuth0Login(
  cfg: ResolvedCliConfig,
  options: LoginOptions,
): Promise<void> {
  const pkce = generatePkce();
  const loopback = await startLoopbackServer(cfg.callbackPorts);
  const spin = ui.spinner();
  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
    const url = buildAuthorizeUrl(cfg, {
      redirectUri,
      state: pkce.state,
      challenge: pkce.challenge,
    });
    ui.log.info(`Browser: ${url}`);
    if (!options.noBrowser) {
      try {
        await open(url);
      } catch {
        // fall through; the user can copy the URL manually
      }
    }
    spin.start("Waiting for browser callback");
    const { code, state } = await loopback.waitForCallback;
    if (state !== pkce.state) {
      throw new Error("State mismatch — aborting to prevent CSRF");
    }
    const exchange = await exchangeCode(cfg, {
      code,
      codeVerifier: pkce.verifier,
      redirectUri,
    });
    const creds = credentialsFromExchange(cfg, exchange);
    await writeCredentials(creds);
    spin.stop("Signed in");
  } catch (err) {
    spin.stop("Login failed");
    throw err;
  } finally {
    loopback.server.close();
  }
}
