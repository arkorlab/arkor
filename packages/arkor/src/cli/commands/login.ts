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
  credentialsPath,
  defaultArkorCloudApiUrl,
  writeCredentials,
  type AnonymousCredentials,
} from "../../core/credentials";
import {
  ANON_PERSISTENCE_NUDGE,
  ANON_SINGLE_DEVICE_NOTE,
  ANON_SINGLE_DEVICE_NOTE_WITH_OAUTH,
  acquireAnonymousTokenResult,
} from "../anonymous";
import { promptSelect, ui } from "../prompts";

export interface LoginOptions {
  /** Force the OAuth browser flow even if `--anonymous` would otherwise be selected interactively. */
  oauth?: boolean;
  anonymous?: boolean;
  /** Skip opening the browser (prints the URL instead). Useful for headless environments. */
  noBrowser?: boolean;
}

export async function runLogin(options: LoginOptions = {}): Promise<void> {
  if (options.oauth && options.anonymous) {
    throw new Error("Pick one of --oauth / --anonymous, not both.");
  }
  if (options.anonymous) {
    // `oauthAvailable` unknown here — we deliberately skip the cfg fetch on
    // the explicit `--anonymous` shortcut so a partially-degraded cloud-api
    // doesn't block the only flow that doesn't need it. Per the gating
    // contract in `../anonymous.ts`, the persistence nudge is suppressed
    // when OAuth availability is unknown (rather than risking a misleading
    // `arkor login --oauth` hint on an anon-only deployment). Users who
    // explicitly typed `--anonymous` already know what they want; losing
    // the nudge for them is a smaller cost than steering anyone at a
    // command that fails.
    await runAnonymousLogin({});
    return;
  }

  const baseUrl = defaultArkorCloudApiUrl();
  const cfg = await fetchCliConfig(baseUrl);
  const oauthAvailable = Boolean(
    cfg.auth0Domain && cfg.clientId && cfg.audience,
  );

  if (!oauthAvailable) {
    if (options.oauth) {
      throw new Error(
        "OAuth is not configured for this deployment. Re-run without --oauth or pass --anonymous.",
      );
    }
    ui.log.info(
      "OAuth is not configured — continuing with an anonymous session.",
    );
    await runAnonymousLogin({ oauthAvailable: false });
    return;
  }

  // PKCE needs a browser callback. `startLoopbackServer().waitForCallback`
  // has no timeout, so a CI run that lands on the OAuth path would hang
  // forever waiting for a redirect that the runner can't make. Fail fast
  // with a clear pointer at the automation-friendly alternative instead.
  //
  // Gated on `process.env.CI` specifically (not the broader
  // `!isInteractive()` check from prompts.ts) so legitimate local
  // headless flows like `arkor login --oauth --no-browser | tee logs`
  // still work — pipes set `process.stdout.isTTY = false` but a browser
  // is still reachable on the user's machine.
  if (options.oauth && process.env.CI) {
    throw new Error(
      "--oauth needs a browser callback that CI runners can't complete. Use --anonymous in CI.",
    );
  }

  // Interactive choice: when neither flag was passed, ask which mode to use.
  // Non-interactive contexts (CI, piped stdout) default to anonymous via
  // `initialValue` because OAuth requires a browser callback that CI can't
  // satisfy — silently falling back to anon is safer than hanging on the
  // PKCE loopback. Automation that wants OAuth must opt in with `--oauth`.
  const mode = options.oauth
    ? "oauth"
    : await promptSelect<"oauth" | "anonymous">({
        message: "How would you like to sign in?",
        options: [
          {
            value: "oauth",
            label: "OAuth (browser)",
            hint: "Sign in to your account (requires an arkor.ai web account)",
          },
          {
            value: "anonymous",
            label: "Anonymous",
            hint: "Throwaway token, no account",
          },
        ],
        initialValue: "anonymous",
      });

  if (mode === "anonymous") {
    await runAnonymousLogin({ oauthAvailable: true });
    return;
  }

  await runAuth0Login(
    {
      auth0Domain: cfg.auth0Domain!,
      clientId: cfg.clientId!,
      audience: cfg.audience!,
      callbackPorts: cfg.callbackPorts,
    },
    options,
  );
}

async function runAnonymousLogin(opts: {
  /**
   * Whether OAuth is *confirmed* available on this deployment. The
   * persistence nudge fires only when this is `true`. `false` (cfg
   * fetched, no Auth0 advertised) and `undefined` (cfg not fetched, e.g.
   * the explicit `--anonymous` shortcut) both suppress the nudge — see
   * the gating contract in `../anonymous.ts`. We err on suppression for
   * the unknown case so users on rare anon-only deployments are never
   * pointed at `arkor login --oauth`, which would fail on those.
   */
  oauthAvailable?: boolean;
}): Promise<void> {
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
  ui.log.info(
    `This id is how Arkor Cloud recognises this client across sessions — keep \`${credentialsPath()}\` to stay signed in as the same anonymous identity.`,
  );
  // see ../anonymous.ts for wording rationale and gating contract.
  if (opts.oauthAvailable === true) {
    ui.log.warn(ANON_PERSISTENCE_NUDGE);
  }
  ui.log.success(`Signed in anonymously (personal org: ${result.orgSlug}).`);
  // Surface the single-device constraint immediately so users don't
  // discover it the hard way when copying credentials.json to a second
  // machine. Same gating contract as `ANON_PERSISTENCE_NUDGE`: the
  // OAuth-flavoured variant fires only when OAuth is *confirmed*
  // available, anything else falls back to the bare fact so anon-only
  // deployments aren't pointed at a command that cannot succeed.
  ui.log.info(
    opts.oauthAvailable === true
      ? ANON_SINGLE_DEVICE_NOTE_WITH_OAUTH
      : ANON_SINGLE_DEVICE_NOTE,
  );
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
