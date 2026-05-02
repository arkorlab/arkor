#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  gitInitialCommit,
  install,
  isInGitRepo,
  resolvePackageManager,
  sanitise,
  scaffold,
  TEMPLATES,
  templateChoices,
  type PackageManager,
  type TemplateId,
} from "@arkor/cli-internal";

interface RunOptions {
  dir?: string;
  name?: string;
  template?: TemplateId;
  yes?: boolean;
  skipInstall?: boolean;
  /** Undefined when neither `--use-*` nor UA detection yielded a pm. */
  packageManager: PackageManager | undefined;
  /** `true` when the user explicitly passed `--git`. Undefined → prompt. */
  git?: boolean;
  /** `true` when the user explicitly passed `--skip-git` (no prompt, no init). */
  skipGit?: boolean;
}

const MANUAL_INSTALL_HINT =
  "install dependencies (npm i / pnpm install / yarn / bun install)";

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/**
 * Truthy when `path` is a non-empty directory — or when it exists but isn't a
 * readable directory at all (file, broken symlink, etc.). Both cases should
 * block scaffolding into an auto-derived `./<name>/` so we don't silently
 * merge into someone else's work.
 */
async function isOccupied(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return true;
  }
}

function collisionMessage(name: string): string {
  return `Directory "${name}/" already exists and is not empty.`;
}

/**
 * Decide whether to run `git init` + initial commit, then (optionally) do it.
 *
 * Policy:
 *   - `--git`       → run without asking
 *   - `--skip-git`  → skip without asking
 *   - `-y` / `--yes` (without --skip-git) → run without asking (matches the
 *     general "accept defaults" semantics; the prompt's default is yes)
 *   - interactive   → prompt (default = yes)
 *   - non-interactive & no flag → skip (never auto-init silently)
 *   - already inside a git repo → skip unconditionally
 */
async function maybeGitInit(
  cwd: string,
  options: RunOptions,
): Promise<void> {
  if (options.skipGit) return;

  if (await isInGitRepo(cwd)) {
    clack.log.info("Directory is already inside a git repository — skipping git init.");
    return;
  }

  let shouldInit: boolean;
  if (options.git === true || options.yes) {
    shouldInit = true;
  } else if (isInteractive()) {
    const answer = await clack.confirm({
      message: "Initialise a git repository and create an initial commit?",
      initialValue: true,
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Cancelled.");
      process.exit(1);
    }
    shouldInit = answer;
  } else {
    shouldInit = false;
  }

  if (!shouldInit) return;

  clack.log.step("Initialising git repository");
  try {
    const result = await gitInitialCommit(
      cwd,
      "Initial commit from Create Arkor",
    );
    if (result.signingFallback) {
      clack.log.warn(
        "Commit signing failed — created an unsigned commit. Re-sign with `git commit --amend -S` once your signing setup is fixed.",
      );
    }
  } catch (err) {
    clack.log.warn(err instanceof Error ? err.message : String(err));
    clack.log.info("You can initialise git manually later.");
  }
}

async function run(options: RunOptions): Promise<void> {
  clack.intro("create-arkor");

  // When `dir` is explicit, derive the project name from its basename so
  // `npm create arkor my-app` still produces `pkg.name = "my-app"`. Otherwise
  // we'd lose the historical UX. `sanitise("")` falls back to "arkor-project"
  // for the root-dir / empty-basename case.
  const defaultName = sanitise(
    options.name ??
      (options.dir !== undefined ? basename(resolve(options.dir)) : "arkor-project"),
  );

  // Always sanitise — `defaultName` is already sanitised, but `options.name`
  // straight from `--name` is not, and falls through to package.json as-is
  // when `--yes` skips the interactive prompt.
  let name = sanitise(options.name ?? defaultName);
  let template: TemplateId = options.template ?? "triage";

  if (!options.yes && isInteractive()) {
    // Re-prompt loop: when the project name is auto-derived into a fresh
    // `./<name>/` subdirectory, refuse to merge into an existing non-empty
    // directory (likely a typo or a forgotten earlier scaffold). Explicit
    // `dir` keeps the historical "scaffold into an existing project"
    // semantics, so we only validate when `options.dir` is undefined.
    //
    // First attempt: empty input field showing `defaultName` as a placeholder;
    // pressing Enter on empty input falls back to `defaultName` via clack's
    // `defaultValue`. After a collision, pre-fill the rejected name as
    // `initialValue` so the user can edit (e.g. add a suffix) instead of
    // retyping, and require non-empty input — otherwise the user could loop
    // forever by pressing Enter on the same colliding default.
    let retryInitial: string | null = null;
    while (true) {
      const chosenName = await clack.text({
        message: "Project name?",
        ...(retryInitial === null
          ? { placeholder: defaultName, defaultValue: defaultName }
          : { initialValue: retryInitial }),
        validate: (v) =>
          retryInitial !== null && !v.trim()
            ? "Project name cannot be empty"
            : undefined,
      });
      if (clack.isCancel(chosenName)) {
        clack.cancel("Cancelled.");
        process.exit(1);
      }
      const sanitised = sanitise(chosenName);
      if (
        options.dir === undefined &&
        (await isOccupied(join(process.cwd(), sanitised)))
      ) {
        clack.log.warn(`${collisionMessage(sanitised)} Pick another name.`);
        retryInitial = sanitised;
        continue;
      }
      name = sanitised;
      break;
    }

    // An explicit `--template <id>` is authoritative: skip the prompt and use it as-is.
    if (options.template === undefined) {
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
  }

  // When no `dir` was passed, scaffold into a fresh subdirectory named after
  // the project — matching `create-vite` / `create-next-app`. Pass `.` (or
  // any path that resolves to `process.cwd()`) to opt into "scaffold here".
  const cwd =
    options.dir !== undefined
      ? resolve(options.dir)
      : join(process.cwd(), name);
  const cdTarget = options.dir ?? name;
  const inPlace = resolve(cwd) === resolve(process.cwd());

  // Guard for the non-interactive / `--yes` paths where we couldn't re-prompt
  // (the interactive loop above already prevents this branch from firing in
  // TTY mode). Explicit `dir` is exempt — same rationale as the loop.
  if (options.dir === undefined && (await isOccupied(cwd))) {
    clack.cancel(
      `${collisionMessage(name)} Pass an explicit [dir] or remove the existing directory first.`,
    );
    process.exit(1);
  }

  const pm = options.packageManager;

  const spin = clack.spinner();
  spin.start(`Scaffolding in ${cwd}`);
  // Pass `packageManager` so yarn picks up `.yarnrc.yml` (avoids
  // yarn-berry's PnP default which the arkor runtime can't load through).
  const { files } = await scaffold({ cwd, name, template, packageManager: pm });
  spin.stop("Done");

  clack.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );

  let installed = false;
  if (!options.skipInstall && pm) {
    clack.log.step(`Installing dependencies with ${pm}`);
    try {
      await install(pm, cwd);
      installed = true;
    } catch (err) {
      clack.log.warn(err instanceof Error ? err.message : String(err));
      clack.log.info(
        inPlace
          ? `Retry manually: ${pm} install`
          : `Retry manually: cd ${cdTarget} && ${pm} install`,
      );
    }
  }

  // git init runs *after* install so the lockfile generated by the package
  // manager lands in the initial commit; otherwise the tree would be dirty
  // immediately after `--git` / `-y` and the bootstrap commit wouldn't be
  // reproducible.
  await maybeGitInit(cwd, options);

  const installLine = installed
    ? null
    : pm
      ? `  ${pm} install`
      : `  ${MANUAL_INSTALL_HINT}`;
  const devLine =
    pm && pm !== "npm" ? `  ${pm} arkor dev` : `  npx arkor dev`;

  clack.outro(
    [
      `Next steps:`,
      ...(inPlace ? [] : [`  cd ${cdTarget}`]),
      ...(installLine ? [installLine] : []),
      devLine,
    ].join("\n"),
  );
}

const program = new Command();

program
  .name("create-arkor")
  .description("Scaffold a TypeScript arkor training project.")
  .argument(
    "[dir]",
    "target directory (default: a new subdirectory named after the project; pass `.` to scaffold into the current directory)",
  )
  .option(
    "--name <name>",
    "project name (default: [dir] basename, else the prompted name, else 'arkor-project')",
  )
  .option(
    "--template <template>",
    "starter template: triage | translate | redaction",
  )
  .option("-y, --yes", "skip interactive prompts and accept the defaults")
  .option("--skip-install", "skip installing dependencies after scaffolding")
  .option("--use-npm", "force npm as the package manager")
  .option("--use-pnpm", "force pnpm as the package manager")
  .option("--use-yarn", "force yarn as the package manager")
  .option("--use-bun", "force bun as the package manager")
  .option(
    "--git",
    "initialise a git repo and create an initial commit (skips the prompt)",
  )
  .option("--skip-git", "skip the git init prompt and do not initialise git")
  .action(
    async (
      dir: string | undefined,
      opts: {
        name?: string;
        template?: string;
        yes?: boolean;
        skipInstall?: boolean;
        useNpm?: boolean;
        usePnpm?: boolean;
        useYarn?: boolean;
        useBun?: boolean;
        git?: boolean;
        skipGit?: boolean;
      },
    ) => {
      if (opts.git && opts.skipGit) {
        throw new Error("Pick one of --git / --skip-git, not both.");
      }
      // Use `Object.hasOwn` (not `in`) so prototype keys like `toString` /
      // `__proto__` can't pass validation and crash later inside scaffold().
      // Reject typos with an explicit error rather than silently coercing them
      // to the default.
      let template: TemplateId | undefined;
      if (opts.template !== undefined) {
        if (!Object.hasOwn(TEMPLATES, opts.template)) {
          throw new Error(
            `Unknown template "${opts.template}". Available: ${Object.keys(TEMPLATES).join(", ")}`,
          );
        }
        template = opts.template as TemplateId;
      }
      const packageManager = resolvePackageManager({
        useNpm: opts.useNpm,
        usePnpm: opts.usePnpm,
        useYarn: opts.useYarn,
        useBun: opts.useBun,
      });
      await run({
        dir,
        name: opts.name,
        template,
        yes: opts.yes,
        skipInstall: opts.skipInstall,
        packageManager,
        git: opts.git,
        skipGit: opts.skipGit,
      });
    },
  );

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `create-arkor failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
