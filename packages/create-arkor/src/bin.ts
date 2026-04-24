#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { detectPackageManager, scaffold, templateChoices } from "./scaffold";
import { install } from "./install";
import type { TemplateId } from "./templates";

interface RunOptions {
  dir?: string;
  name?: string;
  template?: TemplateId;
  yes?: boolean;
  skipInstall?: boolean;
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

function sanitise(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "arkor-project"
  );
}

async function run(options: RunOptions): Promise<void> {
  clack.intro("create-arkor");

  const cwd = options.dir ? resolve(options.dir) : process.cwd();
  const defaultName = sanitise(
    options.name ??
      (options.dir
        ? options.dir.split(/[/\\]/).pop()!
        : process.cwd().split(/[/\\]/).pop()!),
  );

  let name = options.name ?? defaultName;
  let template: TemplateId = options.template ?? "minimal";

  if (!options.yes && isInteractive()) {
    const chosenName = await clack.text({
      message: "Project name?",
      initialValue: defaultName,
      validate: (v) => (v.trim() ? undefined : "Project name cannot be empty"),
    });
    if (clack.isCancel(chosenName)) {
      clack.cancel("Cancelled.");
      process.exit(1);
    }
    name = sanitise(chosenName);

    const chosenTemplate = await clack.select<TemplateId>({
      message: "Starter template?",
      initialValue: template,
      options: templateChoices(),
    });
    if (clack.isCancel(chosenTemplate)) {
      clack.cancel("Cancelled.");
      process.exit(1);
    }
    template = chosenTemplate;
  }

  const spin = clack.spinner();
  spin.start(`Scaffolding in ${cwd}`);
  const { files } = await scaffold({ cwd, name, template });
  spin.stop("Done");

  clack.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );

  const pm = detectPackageManager();

  let installed = false;
  if (!options.skipInstall) {
    clack.log.step(`Installing dependencies with ${pm}`);
    try {
      await install(pm, cwd);
      installed = true;
    } catch (err) {
      clack.log.warn(err instanceof Error ? err.message : String(err));
      clack.log.info(
        `Retry manually: cd ${options.dir ?? "."} && ${pm} install`,
      );
    }
  }

  clack.outro(
    [
      `Next steps:`,
      `  cd ${options.dir ?? "."}`,
      ...(installed ? [] : [`  ${pm} install`]),
      `  ${pm === "npm" ? "npx arkor" : `${pm} arkor`} train`,
    ].join("\n"),
  );
}

const program = new Command();

program
  .name("create-arkor")
  .description("Scaffold a TypeScript arkor training project.")
  .argument("[dir]", "target directory (default: current directory)")
  .option("--name <name>", "project name (default: directory name)")
  .option(
    "--template <template>",
    "starter template: minimal | alpaca | chatml",
  )
  .option("-y, --yes", "skip interactive prompts and accept the defaults")
  .option("--skip-install", "skip installing dependencies after scaffolding")
  .action(
    async (
      dir: string | undefined,
      opts: {
        name?: string;
        template?: string;
        yes?: boolean;
        skipInstall?: boolean;
      },
    ) => {
      const template =
        opts.template === "minimal" ||
        opts.template === "alpaca" ||
        opts.template === "chatml"
          ? opts.template
          : undefined;
      await run({
        dir,
        name: opts.name,
        template,
        yes: opts.yes,
        skipInstall: opts.skipInstall,
      });
    },
  );

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `create-arkor failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
