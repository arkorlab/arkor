#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
 * Decide whether to run `git init` + initial commit, surfacing the prompt
 * upfront so the user doesn't sit at an interactive question after the long
 * `<pm> install` step finishes. Returns `true` if `runGitInit` should fire
 * later (after install).
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
async function decideGitInit(
  cwd: string,
  options: RunOptions,
): Promise<boolean> {
  if (options.skipGit) return false;

  if (await isInGitRepo(cwd)) {
    clack.log.info("Directory is already inside a git repository — skipping git init.");
    return false;
  }

  if (options.git === true || options.yes) return true;
  if (!isInteractive()) return false;

  const answer = await clack.confirm({
    message: "Initialise a git repository and create an initial commit?",
    initialValue: true,
  });
  if (clack.isCancel(answer)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }
  return answer;
}

async function runGitInit(cwd: string): Promise<void> {
  // Re-check inside the post-install window: `decideGitInit` ran before
  // the long install, and the user / tooling may have run `git init`
  // themselves in the meantime. Without this check we'd silently add a
  // second commit on top of their repo, breaking the policy table's
  // "already inside a git repo → skip" rule.
  if (await isInGitRepo(cwd)) {
    clack.log.info(
      "Directory became a git repository during install — skipping git init.",
    );
    return;
  }
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

// Exported so the focused unit test in `bin.test.ts` can call `run()`
// directly without spawning the bundled binary. Commander still owns
// argv parsing in production — `run()` is the side-effecting kernel
// the parser hands off to.
export async function run(options: RunOptions): Promise<void> {
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
  const { files, warnings } = await scaffold({ cwd, name, template, packageManager: pm });
  spin.stop("Done");

  clack.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );
  // Surface non-fatal scaffolder advisories (see arkor init for the
  // mirror of this loop and the rationale).
  for (const warning of warnings) {
    clack.log.warn(warning);
  }

  // Resolve the git-init choice before kicking off install so the user can
  // walk away once they've answered every prompt; otherwise they'd sit at an
  // interactive question after a multi-minute `<pm> install`. Execution still
  // happens after install — the lockfile generated by the package manager
  // must land in the initial commit, otherwise the tree would be dirty right
  // after `--git` / `-y` and the bootstrap commit wouldn't be reproducible.
  const shouldInitGit = await decideGitInit(cwd, options);

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

  if (shouldInitGit) await runGitInit(cwd);

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

// Only parse argv when this module is the entrypoint. Tests
// (`bin.test.ts`) import `run` directly to exercise the side-effect
// kernel without commander spinning up on vitest's argv.
//
// `process.argv[1]` is the path Node was invoked with — under
// `npm create arkor` / `pnpm create arkor` / `npx create-arkor` it's
// the symlink/shim at `node_modules/.bin/create-arkor`, while
// `import.meta.url` is the *resolved* path Node loaded the module
// from (`--preserve-symlinks-main` defaults to false). A naïve
// equality check between the two skips `program.parseAsync` for
// every package-manager invocation and the CLI silently exits doing
// nothing — Codex P1 / Copilot review on PR #99 round 7 flagged
// the regression I introduced in round 6. Realpath both sides
// before comparing so the symlink and its target collapse.
// Exported so `bin.test.ts` can drive the comparison with a synthetic
// symlink/target pair without spawning the real binary.
export function shouldRunAsCli(
  argv1: string | undefined,
  moduleUrl: string,
): boolean {
  if (!argv1) return false;
  const resolveSafe = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    // Non-file URL (e.g. data:, vitest's transform URL) — never CLI.
    return false;
  }
  return resolveSafe(argv1) === resolveSafe(modulePath);
}

if (shouldRunAsCli(process.argv[1], import.meta.url)) {
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(
      `create-arkor failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
