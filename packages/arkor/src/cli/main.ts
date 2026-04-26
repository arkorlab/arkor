import { Command } from "commander";
import { runTrainer } from "../core/runner";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runWhoami } from "./commands/whoami";
import { runJobsCancel, runJobsGet, runJobsList } from "./commands/jobs";
import { runLogs } from "./commands/logs";
import { runInit } from "./commands/init";
import { runDev } from "./commands/dev";
import { runBuild } from "./commands/build";
import { runStart } from "./commands/start";
import { resolvePackageManager } from "@arkor/cli-internal";

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("arkor").description("Arkor CLI").version("0.0.1-alpha.0");

  program
    .command("init")
    .description("Scaffold src/arkor/index.ts + arkor.config.ts in the current directory")
    .option("-y, --yes", "Accept defaults instead of prompting")
    .option("--name <name>", "Project name (default: directory name)")
    .option("--template <template>", "Starter template: minimal | alpaca | chatml")
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
          template: opts.template as "minimal" | "alpaca" | "chatml" | undefined,
          skipInstall: opts.skipInstall,
          packageManager,
          git: opts.git,
          skipGit: opts.skipGit,
        });
      },
    );

  program
    .command("login")
    .description("Sign in to arkor (Auth0 Authorization Code + PKCE on loopback)")
    .option("--anonymous", "Issue a throwaway anonymous token instead")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(
      async (opts: {
        anonymous?: boolean;
        browser?: boolean;
      }) => {
        await runLogin({
          anonymous: opts.anonymous,
          noBrowser: opts.browser === false,
        });
      },
    );

  program
    .command("logout")
    .description("Delete ~/.arkor/credentials.json")
    .option("-y, --yes", "Skip confirmation")
    .action(async (opts: { yes?: boolean }) => {
      await runLogout({ yes: opts.yes });
    });

  program
    .command("whoami")
    .description("Print the current identity and reachable orgs")
    .action(async () => {
      await runWhoami();
    });

  program
    .command("train")
    .description("Run a training job defined in TypeScript")
    .argument("[file]", "path to the training entry (default: src/arkor/index.ts)")
    .action(async (file?: string) => {
      await runTrainer(file);
    });

  const jobs = program.command("jobs").description("List / inspect / cancel jobs");
  jobs
    .command("list")
    .description("List jobs in the current project")
    .action(async () => {
      await runJobsList();
    });
  jobs
    .command("get")
    .description("Show a single job")
    .argument("<id>", "job id")
    .action(async (id: string) => {
      await runJobsGet(id);
    });
  jobs
    .command("cancel")
    .description("Cancel a queued or running job")
    .argument("<id>", "job id")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts: { yes?: boolean }) => {
      await runJobsCancel(id, { yes: opts.yes });
    });

  program
    .command("logs")
    .description("Print / tail training events for a job")
    .argument("<id>", "job id")
    .option("-f, --follow", "Follow the SSE stream until the job finishes")
    .action(async (id: string, opts: { follow?: boolean }) => {
      await runLogs(id, { follow: opts.follow });
    });

  program
    .command("build")
    .description("Bundle src/arkor/index.ts into .arkor/build/index.mjs")
    .argument("[entry]", "path to the source entry (default: src/arkor/index.ts)")
    .action(async (entry?: string) => {
      await runBuild({ entry });
    });

  program
    .command("start")
    .description("Run the build artifact at .arkor/build/index.mjs")
    .argument("[entry]", "rebuild from this entry before running (optional)")
    .action(async (entry?: string) => {
      await runStart({ entry });
    });

  program
    .command("dev")
    .description("Launch Arkor Studio locally")
    .option("-p, --port <port>", "Port to bind (default: 4000)", "4000")
    .option("--no-browser", "Do not open the browser")
    .action(async (opts: { port: string; browser?: boolean }) => {
      await runDev({
        port: Number(opts.port) || 4000,
        noBrowser: opts.browser === false,
      });
    });

  await program.parseAsync(argv, { from: "user" });
}
