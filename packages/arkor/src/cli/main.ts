import { Command } from "commander";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runWhoami } from "./commands/whoami";
import { runInit } from "./commands/init";
import { runDev } from "./commands/dev";
import { runBuild } from "./commands/build";
import { runStart } from "./commands/start";
import { resolvePackageManager, type TemplateId } from "@arkor/cli-internal";
import {
  formatAnonymousAuthError,
  isAnonymousAuthDeadEnd,
} from "../core/anonymous-auth-error";
import { fetchCliConfig } from "../core/auth0";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
} from "../core/credentials";
import { getRecordedDeprecation } from "../core/deprecation";
import { shutdownTelemetry, withTelemetry } from "../core/telemetry";
import { detectedUpgradeCommand } from "../core/upgrade-hint";
import { SDK_VERSION } from "../core/version";
import { ui } from "./prompts";

/**
 * Resolve OAuth availability for the current deployment so anonymous-auth
 * dead-end errors recommend a recovery path that actually works on
 * anon-only deployments. Probes the *credentials' own* cloud-api URL
 * (the one that just produced the auth error), not the global default
 * — `ARKOR_CLOUD_API_URL` may have changed since the credentials were
 * issued, or a command may have run against a non-default endpoint, in
 * which case probing `defaultArkorCloudApiUrl()` would inspect the
 * wrong deployment and recommend the opposite recovery path.
 *
 * Returns a tri-state rather than a boolean. An earlier version
 * collapsed every probe failure to `false`, which made the formatter
 * confidently steer users at `arkor login --anonymous` even when the
 * config endpoint was just timing out on an OAuth-supporting
 * deployment, hiding the real recovery (`arkor login --oauth`).
 * Distinguishing the cases lets the formatter hedge when we genuinely
 * don't know:
 *
 * - `"available"`: cfg fetched, Auth0 fields present → `--oauth`.
 * - `"absent"`: cfg fetched, no Auth0 fields → `--anonymous`.
 * - `"unknown"`: probe failed (network, timeout, malformed cfg,
 *    missing credentials) → suggest both, with an honest hedge.
 *
 * The probe runs *after* a command has already failed, so blocking
 * the recovery hint behind an unbounded HTTP call would compound the
 * outage. `AbortSignal.timeout` caps the probe at 3 s so the user
 * always gets *some* guidance even when the cloud-api is sick. That
 * timeout falls into `"unknown"`.
 */
type OauthAvailability = "available" | "absent" | "unknown";
const PROBE_TIMEOUT_MS = 3000;
async function probeOauthAvailability(): Promise<OauthAvailability> {
  try {
    const creds = await readCredentials().catch(() => null);
    // Only `AnonymousCredentials` carries `arkorCloudApiUrl`; the
    // anon-auth-error path only fires for anonymous tokens anyway, but
    // we defensively fall through to the global default for any other
    // shape rather than throwing on a `Auth0Credentials` narrowing.
    const baseUrl =
      creds?.mode === "anon" && creds.arkorCloudApiUrl
        ? creds.arkorCloudApiUrl
        : defaultArkorCloudApiUrl();
    const cfg = await fetchCliConfig(baseUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return cfg.auth0Domain && cfg.clientId && cfg.audience
      ? "available"
      : "absent";
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("arkor").description("Arkor CLI").version(SDK_VERSION);

  program
    .command("init")
    .description("Scaffold src/arkor/index.ts + arkor.config.ts in the current directory")
    .option("-y, --yes", "Accept defaults instead of prompting")
    .option("--name <name>", "Project name (default: directory name)")
    .option("--template <template>", "Starter template: triage | translate | redaction")
    .option("--skip-install", "Skip installing dependencies after scaffolding")
    .option("--use-npm", "Force npm as the package manager")
    .option("--use-pnpm", "Force pnpm as the package manager")
    .option("--use-yarn", "Force yarn as the package manager")
    .option("--use-bun", "Force bun as the package manager")
    .option(
      "--git",
      "Initialise a git repo and create an initial commit (skips the prompt)",
    )
    .option("--skip-git", "Skip the git init prompt and do not initialise git")
    .action(
      withTelemetry("init", async (opts: {
        yes?: boolean;
        name?: string;
        template?: string;
        skipInstall?: boolean;
        useNpm?: boolean;
        usePnpm?: boolean;
        useYarn?: boolean;
        useBun?: boolean;
        git?: boolean;
        skipGit?: boolean;
      }) => {
        if (opts.git && opts.skipGit) {
          throw new Error("Pick one of --git / --skip-git, not both.");
        }
        const packageManager = resolvePackageManager({
          useNpm: opts.useNpm,
          usePnpm: opts.usePnpm,
          useYarn: opts.useYarn,
          useBun: opts.useBun,
        });
        await runInit({
          yes: opts.yes,
          name: opts.name,
          template: opts.template as TemplateId | undefined,
          skipInstall: opts.skipInstall,
          packageManager,
          git: opts.git,
          skipGit: opts.skipGit,
        });
      }),
    );

  program
    .command("login")
    .description("Sign in to arkor (OAuth Authorization Code + PKCE on loopback)")
    .option("--oauth", "Sign in via OAuth in the browser")
    .option("--anonymous", "Issue a throwaway anonymous token instead")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(
      withTelemetry("login", async (opts: {
        oauth?: boolean;
        anonymous?: boolean;
        browser?: boolean;
      }) => {
        if (opts.oauth && opts.anonymous) {
          throw new Error("Pick one of --oauth / --anonymous, not both.");
        }
        await runLogin({
          oauth: opts.oauth,
          anonymous: opts.anonymous,
          noBrowser: opts.browser === false,
        });
      }),
    );

  program
    .command("logout")
    .description("Delete ~/.arkor/credentials.json")
    .option("-y, --yes", "Skip confirmation")
    .action(
      withTelemetry("logout", async (opts: { yes?: boolean }) => {
        await runLogout({ yes: opts.yes });
      }),
    );

  program
    .command("whoami")
    .description("Print the current identity and reachable orgs")
    .action(
      withTelemetry("whoami", async () => {
        await runWhoami();
      }),
    );

  program
    .command("build")
    .description("Bundle src/arkor/index.ts into .arkor/build/index.mjs")
    .argument("[entry]", "path to the source entry (default: src/arkor/index.ts)")
    .action(
      withTelemetry("build", async (entry?: string) => {
        await runBuild({ entry });
      }),
    );

  program
    .command("start")
    .description("Run the build artifact at .arkor/build/index.mjs")
    .argument("[entry]", "rebuild from this entry before running (optional)")
    .action(
      withTelemetry("start", async (entry?: string) => {
        await runStart({ entry });
      }),
    );

  program
    .command("dev")
    .description("Launch Arkor Studio locally")
    .option("-p, --port <port>", "Port to bind (default: 4000)", "4000")
    .option("--open", "Open the Studio URL in a browser after starting")
    .action(
      withTelemetry(
        "dev",
        async (opts: { port: string; open?: boolean }) => {
          await runDev({
            port: Number(opts.port) || 4000,
            open: opts.open === true,
          });
        },
        { longRunning: true },
      ),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    // Intercept the structured anonymous-auth-state errors before they
    // propagate to bin.ts and get rendered with a stack trace. Only the
    // two known dead-end codes (`anonymous_token_single_device`,
    // `anonymous_account_not_found`) are formatted here; everything
    // else rethrows so the existing fallback in bin.ts surfaces it.
    // Setting `process.exitCode` (rather than calling `process.exit`
    // directly) keeps the deprecation + telemetry-shutdown step in the
    // `finally` block reachable.
    if (isAnonymousAuthDeadEnd(err)) {
      // Probe deployment OAuth status only on the dead-end path so we
      // don't add a network round-trip to every successful command.
      // The probe is tri-state (`"available"` / `"absent"` /
      // `"unknown"`), so the formatter can hedge instead of
      // confidently recommending `--anonymous` when the config
      // endpoint just timed out on an OAuth-supporting deployment.
      const probe = await probeOauthAvailability();
      const friendly = formatAnonymousAuthError(err, {
        oauthAvailable:
          probe === "available"
            ? true
            : probe === "absent"
              ? false
              : undefined,
      });
      if (friendly !== null) {
        process.stderr.write(`${friendly}\n`);
        process.exitCode = 1;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  } finally {
    const notice = getRecordedDeprecation();
    if (notice) {
      const sunset = notice.sunset ? ` Cutoff: ${notice.sunset}.` : "";
      ui.log.warn(
        `${notice.message} (current: ${SDK_VERSION}).${sunset} Run \`${detectedUpgradeCommand()}\`.`,
      );
    }
    await shutdownTelemetry();
  }
}
