import {
  ClaudeCodeStrictExit,
  ExpectedCliError,
  formatClaudeCodeAgentModeMessage,
  formatClaudeCodeMissingMessage,
  isClaudeCode,
  missingClaudeCodeFlags,
  resolvePackageManager,
  type TemplateId,
} from "@arkor/cli-internal";
import { Command } from "commander";

import { getRecordedDeprecation } from "../core/deprecation";
import { shutdownTelemetry, withTelemetry } from "../core/telemetry";
import { detectedUpgradeCommand } from "../core/upgrade-hint";
import { SDK_VERSION } from "../core/version";

import { runBuild } from "./commands/build";
import { runDev } from "./commands/dev";
import { runInit } from "./commands/init";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runStart } from "./commands/start";
import { runWhoami } from "./commands/whoami";
import { ui } from "./prompts";

/**
 * Parse and validate `arkor dev --port`. The previous `Number(opts.port) ||
 * 4000` silently coerced a typo (`--port abc` -> NaN -> 4000) and a legitimate
 * ephemeral request (`--port 0` -> 4000), and let an out-of-range value reach
 * `net.Server.listen`, which throws `ERR_SOCKET_BAD_PORT` synchronously before
 * the friendly EADDRINUSE handler is even registered (surfacing a raw minified
 * stack). Validate here so a bad value is a clear, actionable message. Port 0
 * (OS-assigned) is rejected on purpose: `arkor dev` prints and probes a fixed
 * `http://localhost:<port>` URL, so an ephemeral port has no supported flow.
 */
function parseDevPort(raw: string): number {
  // Require a canonical decimal-integer string (no leading zero). `Number()`
  // alone would accept hex (`0x1F4`), scientific notation (`4e3`), decimals
  // (`500.0`), whitespace-padded, and zero-padded (`080`) values, binding a
  // surprising port while the error copy (and the docs) promise "an integer".
  // `/^[1-9]\d*$/` keeps the contract honest.
  const n = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new ExpectedCliError(
      `--port must be an integer between 1 and 65535 (got ${JSON.stringify(
        raw,
      )}).`,
    );
  }
  return n;
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("arkor").description("Arkor CLI").version(SDK_VERSION);

  program
    .command("init")
    .description(
      "Scaffold an Arkor project in the current directory: src/arkor/{index,trainer}.ts, arkor.config.ts, README.md, .gitignore, package.json, and AGENTS.md / CLAUDE.md (skip the agent files with --no-agents-md). Existing files are patched non-destructively.",
    )
    .option("-y, --yes", "Accept defaults instead of prompting")
    .option("--name <name>", "Project name (default: directory name)")
    .option(
      "--template <template>",
      "Starter template: triage | translate | redaction",
    )
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
    .option(
      "--allow-builds",
      "Opt esbuild's postinstall script into running on `pnpm install` (pnpm-only; default: deny, since pnpm 11 errors on ignored builds and the scaffold writes `allowBuilds: { esbuild: false }` to silence it)",
    )
    .option(
      "--agents-md",
      "Include AGENTS.md and CLAUDE.md to guide AI coding agents (default)",
    )
    .option("--no-agents-md", "Skip generating AGENTS.md and CLAUDE.md")
    .action(
      withTelemetry(
        "init",
        async (opts: {
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
          allowBuilds?: boolean;
          // Commander v13 leaves this undefined unless one of --agents-md /
          // --no-agents-md was passed; the action treats undefined as the
          // default-on value.
          agentsMd?: boolean;
        }) => {
          if (opts.git && opts.skipGit) {
            throw new Error("Pick one of --git / --skip-git, not both.");
          }
          // Commander treats `--agents-md` and `--no-agents-md` as the same
          // option (last-wins), so it will not surface a conflict on its
          // own. Mirror the `--git` / `--skip-git` check by inspecting the
          // raw argv passed to `main()`: using `process.argv` directly
          // would miss the conflict when called from tests via
          // `main([...])` and could false-positive on the parent process's
          // own arguments. Stop scanning at the POSIX `--` end-of-options
          // sentinel so a positional that happens to start with `--` is
          // not misclassified as a conflicting flag.
          const sentinelIdx = argv.indexOf("--");
          const flagsArgv =
            sentinelIdx === -1 ? argv : argv.slice(0, sentinelIdx);
          if (
            flagsArgv.includes("--agents-md") &&
            flagsArgv.includes("--no-agents-md")
          ) {
            throw new Error(
              "Pick one of --agents-md / --no-agents-md, not both.",
            );
          }
          // Under CLAUDECODE=1, refuse to fall through to interactive prompts
          // (they'd hang) or to silent defaults (they'd hide decisions the
          // agent should be making). Print the suggested re-invocation and
          // exit 1 so the agent can re-run with explicit flags. `agentsMd`
          // is checked from raw argv so default-on doesn't satisfy the
          // requirement: the agent should opt in or out deliberately.
          if (isClaudeCode()) {
            const agentsMdSpecified =
              flagsArgv.includes("--agents-md") ||
              flagsArgv.includes("--no-agents-md");
            const missing = missingClaudeCodeFlags({
              yes: opts.yes,
              template: opts.template,
              git: opts.git,
              skipGit: opts.skipGit,
              skipInstall: opts.skipInstall,
              useNpm: opts.useNpm,
              usePnpm: opts.usePnpm,
              useYarn: opts.useYarn,
              useBun: opts.useBun,
              name: opts.name,
              agentsMd: agentsMdSpecified ? (opts.agentsMd ?? true) : undefined,
              // arkor init operates on `process.cwd()`; basename(cwd) is
              // the runtime default for the project name, so strict mode
              // doesn't require an explicit `--name`. Passing `initCwd`
              // lets the validator reject the pathological case where
              // the cwd basename itself has no alphanumerics (e.g.
              // `/tmp/!!!/`), which would otherwise sanitise to the
              // generic `arkor-project` fallback.
              requireProjectName: false,
              initCwd: process.cwd(),
            });
            if (missing.length > 0) {
              process.stderr.write(
                formatClaudeCodeMissingMessage("arkor init", missing),
              );
              // Throw (don't `process.exit`) so the `finally` at the bottom of
              // main() still runs telemetry shutdown / the deprecation notice.
              // bin.ts recognises this sentinel and exits without re-printing
              // the message.
              throw new ClaudeCodeStrictExit();
            }
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
            allowBuilds: opts.allowBuilds,
            // Commander v13 leaves opts.agentsMd undefined when no flag is
            // passed; default to on so `arkor init` matches `create-arkor`.
            // Only explicit `--no-agents-md` (which sets `false`) opts out.
            agentsMd: opts.agentsMd !== false,
          });
        },
      ),
    );

  program
    .command("login")
    .description(
      "Sign in to arkor (OAuth Authorization Code + PKCE on loopback)",
    )
    .option("--oauth", "Sign in via OAuth in the browser")
    .option("--anonymous", "Issue a throwaway anonymous token instead")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(
      withTelemetry(
        "login",
        async (opts: {
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
        },
      ),
    );

  program
    .command("logout")
    .description("Delete ~/.arkor/credentials.json")
    .option("-f, --force", "Delete credentials without prompting")
    .action(
      withTelemetry("logout", async (opts: { force?: boolean }) => {
        await runLogout({ force: opts.force });
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
    .argument(
      "[entry]",
      "path to the source entry (default: src/arkor/index.ts)",
    )
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
    .option(
      "--agent",
      "Run headlessly for coding agents: write a JSON session token file to .arkor/agent/ and print its path",
    )
    .action((opts: { port: string; open?: boolean; agent?: boolean }) => {
      // `dev` is long-running when it serves, but a short-lived completion
      // when it connects to an already-running Studio and exits. Track the
      // outcome so telemetry emits `cli_command_completed` for the connect
      // case (the `longRunning` predicate is evaluated after the handler
      // resolves). Wrapped per-invocation so the closure flag is fresh.
      let adopted = false;
      return withTelemetry(
        "dev",
        async () => {
          // Under CLAUDECODE=1 a Studio launch without --agent is almost
          // always a mistake: the agent cannot drive a browser UI and the
          // long-running server would hang its shell. Require the explicit
          // --agent opt-in (same sentinel pattern as the `init` gate above).
          // The flag itself does NOT require the env var: other coding
          // agents opt in with a plain `arkor dev --agent`.
          if (isClaudeCode() && opts.agent !== true) {
            process.stderr.write(formatClaudeCodeAgentModeMessage("arkor dev"));
            throw new ClaudeCodeStrictExit();
          }
          const result = await runDev({
            port: parseDevPort(opts.port),
            open: opts.open === true,
            agent: opts.agent === true,
          });
          adopted = result.adopted;
        },
        { longRunning: () => !adopted },
      )();
    });

  try {
    await program.parseAsync(argv, { from: "user" });
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
