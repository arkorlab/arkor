import { basename } from "node:path";
import {
  gitInitialCommit,
  install,
  isInGitRepo,
  sanitise,
  scaffold,
  TEMPLATES,
  templateChoices,
  type PackageManager,
  type TemplateId,
} from "@arkor/cli-internal";
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  promptText,
  ui,
} from "../prompts";

export interface InitOptions {
  yes?: boolean;
  name?: string;
  template?: TemplateId;
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
  options: InitOptions,
): Promise<boolean> {
  if (options.skipGit) return false;

  if (await isInGitRepo(cwd)) {
    ui.log.info(
      "Directory is already inside a git repository — skipping git init.",
    );
    return false;
  }

  if (options.git === true || options.yes) return true;
  if (!isInteractive()) return false;

  return promptConfirm({
    message: "Initialise a git repository and create an initial commit?",
    initialValue: true,
  });
}

async function runGitInit(cwd: string): Promise<void> {
  // Re-check inside the post-install window: `decideGitInit` ran before
  // the long install, and the user / tooling may have run `git init`
  // themselves in the meantime. Without this check we'd silently add a
  // second commit on top of their repo, breaking the policy table's
  // "already inside a git repo → skip" rule.
  if (await isInGitRepo(cwd)) {
    ui.log.info(
      "Directory became a git repository during install — skipping git init.",
    );
    return;
  }
  ui.log.step("Initialising git repository");
  try {
    const result = await gitInitialCommit(
      cwd,
      "Initial commit from `arkor init`",
    );
    if (result.signingFallback) {
      ui.log.warn(
        "Commit signing failed — created an unsigned commit. Re-sign with `git commit --amend -S` once your signing setup is fixed.",
      );
    }
  } catch (err) {
    ui.log.warn(err instanceof Error ? err.message : String(err));
    ui.log.info("You can initialise git manually later.");
  }
}

export async function runInit(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  // `path.basename` correctly handles trailing separators and the
  // filesystem root (`/`, `C:\`), where the previous split-and-pop
  // returned an empty string and `??` left it through (only null/undefined
  // trigger the fallback). `basename("/")` returns `""`, hence the `||`.
  const defaultName = basename(cwd) || "arkor-project";

  // Reject typos / unknown template ids before any prompt or filesystem work.
  // `Object.hasOwn` (not `in`) so prototype keys like `toString` / `__proto__`
  // can't pass validation and crash later inside scaffold().
  if (
    options.template !== undefined &&
    !Object.hasOwn(TEMPLATES, options.template)
  ) {
    throw new Error(
      `Unknown template "${options.template}". Available: ${Object.keys(TEMPLATES).join(", ")}`,
    );
  }

  ui.intro("arkor init");
  const projectName = await promptText({
    message: "Project name?",
    initialValue: options.name ?? defaultName,
    skipWith: options.yes ? options.name ?? defaultName : undefined,
  });
  // An explicit `--template <id>` is authoritative: skip the prompt and use it as-is.
  const template = await promptSelect<TemplateId>({
    message: "Starter template?",
    initialValue: options.template ?? "triage",
    options: templateChoices(),
    skipWith: options.template ?? (options.yes ? "triage" : undefined),
  });

  // Sanitise here so `--name "Foo Bar"` (which bypasses prompts under
  // `--yes` / non-interactive) doesn't end up in `package.json` as-is.
  const { files } = await scaffold({ cwd, name: sanitise(projectName), template });

  ui.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );

  // Resolve the git-init choice before kicking off install so the user can
  // walk away once they've answered every prompt; otherwise they'd sit at an
  // interactive question after a multi-minute `<pm> install`. Execution still
  // happens after install — the lockfile generated by the package manager
  // must land in the initial commit, otherwise the tree would be dirty right
  // after `--git` / `-y` and the bootstrap commit wouldn't be reproducible.
  const shouldInitGit = await decideGitInit(cwd, options);

  const pm = options.packageManager;

  let installed = false;
  if (!options.skipInstall && pm) {
    ui.log.step(`Installing dependencies with ${pm}`);
    try {
      await install(pm, cwd);
      installed = true;
    } catch (err) {
      ui.log.warn(err instanceof Error ? err.message : String(err));
      ui.log.info(`Retry manually: ${pm} install`);
    }
  }

  if (shouldInitGit) await runGitInit(cwd);

  const devCmd =
    pm && pm !== "npm" ? `${pm} dev` : "npm run dev";
  ui.outro(
    installed
      ? `Next: \`${devCmd}\``
      : pm
        ? `Next: \`${pm} install\`, then \`${devCmd}\``
        : `Next: ${MANUAL_INSTALL_HINT}, then \`${devCmd}\``,
  );
}
