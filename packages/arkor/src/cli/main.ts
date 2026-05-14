import { Command } from "commander";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runWhoami } from "./commands/whoami";
import { runInit } from "./commands/init";
import { runDev } from "./commands/dev";
import { runBuild } from "./commands/build";
import { runStart } from "./commands/start";
import {
  formatClaudeCodeMissingMessage,
  isClaudeCode,
  missingClaudeCodeFlags,
  resolvePackageManager,
  type TemplateId,
} from "@arkor/cli-internal";
import { getRecordedDeprecation } from "../core/deprecation";
import { shutdownTelemetry, withTelemetry } from "../core/telemetry";
import { detectedUpgradeCommand } from "../core/upgrade-hint";
import { SDK_VERSION } from "../core/version";
import { ui } from "./prompts";

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
    .option(
      "--agents-md",
      "Include AGENTS.md and CLAUDE.md to guide AI coding agents (default)",
    )
    .option("--no-agents-md", "Skip generating AGENTS.md and CLAUDE.md")
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
        // raw argv passed to `main()` — using `process.argv` directly
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
            agentsMd: agentsMdSpecified ? opts.agentsMd ?? true : undefined,
            // arkor init operates on `process.cwd()`; basename(cwd) is a
            // meaningful default name, so an explicit --name isn't
            // required.
            requireProjectName: false,
          });
          if (missing.length > 0) {
            process.stderr.write(
              formatClaudeCodeMissingMessage("arkor init", missing),
            );
            process.exit(1);
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
          // Commander v13 leaves opts.agentsMd undefined when no flag is
          // passed; default to on so `arkor init` matches `create-arkor`.
          // Only explicit `--no-agents-md` (which sets `false`) opts out.
          agentsMd: opts.agentsMd !== false,
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
