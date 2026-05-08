import { basename } from "node:path";
import {
  gitInitialCommit,
  hasEnclosingNodeModules,
  install,
  isInGitRepo,
  lockfileChangedSince,
  sanitise,
  scaffold,
  snapshotLockfile,
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
  /**
   * `true` when the user explicitly passed `--allow-builds`. Threads through
   * to `scaffold()` so the emitted `pnpm-workspace.yaml#allowBuilds.esbuild`
   * is `true` instead of the secure-by-default `false`. Only meaningful for
   * pnpm (yarn / npm / bun ignore the workspace yaml), but we plumb the
   * flag unconditionally — a user who scaffolds with `--use-npm` today and
   * later switches to pnpm would otherwise have to re-run with the flag.
   */
  allowBuilds?: boolean;
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
  // Pass `packageManager` so yarn picks up `.yarnrc.yml` (avoids
  // yarn-berry's PnP default which the arkor runtime can't load through).
  const { files, warnings, blockInstall } = await scaffold({
    cwd,
    name: sanitise(projectName),
    template,
    packageManager: options.packageManager,
    allowBuilds: options.allowBuilds,
  });

  ui.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );
  // Surface non-fatal scaffolder advisories (currently: existing
  // `.yarnrc.yml` with `nodeLinker:` set to a value the arkor runtime
  // can't load through, or yarn-berry merge into an existing project
  // where we declined to write `.yarnrc.yml` defensively). The
  // install step below also consults `blockInstall` and bows out
  // when these advisories fire — running `yarn install` against an
  // unfixed PnP setup produces no `node_modules` and leaves the
  // project broken, so install would be worse than useless.
  for (const warning of warnings) {
    ui.log.warn(warning);
  }

  // Resolve the git-init choice before kicking off install so the user can
  // walk away once they've answered every prompt; otherwise they'd sit at an
  // interactive question after a multi-minute `<pm> install`. Execution still
  // happens after install — the lockfile generated by the package manager
  // must land in the initial commit, otherwise the tree would be dirty right
  // after `--git` / `-y` and the bootstrap commit wouldn't be reproducible.
  const shouldInitGit = await decideGitInit(cwd, options);

  const pm = options.packageManager;

  let installed = false;
  // Round 39 (Codex P1, PR #99): snapshot the closest-enclosing
  // lockfile BEFORE install so the post-install gate can prove
  // install actually changed something on disk. Without the
  // pre-snapshot, a workspace-subdir scaffold with a stale
  // ancestor lockfile would treat any failed install as
  // "lockfile landed" via existsSync alone — letting the CLI
  // run git init over an untouched tree.
  const lockfileBefore = snapshotLockfile(cwd, pm);
  if (!options.skipInstall && pm) {
    if (blockInstall) {
      // Round 17 (Copilot, PR #99): the yarn-config advisories above
      // tell the user to fix `.yarnrc.yml` before running `yarn
      // install`. Running install ourselves first would produce an
      // empty `node_modules` (yarn 4 PnP) and leave `arkor dev` /
      // `arkor train` broken — the install becomes worse than
      // useless. Skip and surface the manual-retry hint instead, so
      // the user fixes the config first and retries.
      ui.log.info(
        `Skipping install — fix the advisory above first, then run: ${pm} install`,
      );
    } else {
      ui.log.step(`Installing dependencies with ${pm}`);
      try {
        await install(pm, cwd);
        installed = true;
      } catch (err) {
        ui.log.warn(err instanceof Error ? err.message : String(err));
        ui.log.info(`Retry manually: ${pm} install`);
      }
    }
  }

  // Round 19 (Copilot, PR #99): when blockInstall is true AND
  // an install was actually going to run, skipping git init
  // preserves the "lockfile lands in the initial commit"
  // invariant — committing now would capture an empty
  // `node_modules`-less tree, and a re-run after the advisory
  // is fixed would either skip git ("already inside a git repo")
  // or stack a second commit on top.
  //
  // Round 21 (Codex P2, PR #99): the rationale only applies when
  // install was actually going to run. If the user explicitly
  // passed `--skip-install`, no install was happening anyway,
  // there's no lockfile to wait for, and `--git`/`-y` is an
  // explicit request we shouldn't second-guess. Same goes for
  // `pm === undefined` (manual install hint flow). Gate the
  // skip on "install would have run".
  //
  // Round 21 (Copilot, PR #99): the recovery hint used to
  // prescribe `arkor init` as the rerun command, but the local
  // `arkor` bin isn't on PATH yet (we just skipped install) and
  // the hint dropped any flags the user originally passed
  // (`--use-yarn` / `--git` / `--name` / etc). Drop the
  // prescriptive command — point at the advisory and let the
  // user re-invoke with whatever they originally typed.
  // Round 35 (Copilot, PR #99): the lockfile-in-initial-commit
  // invariant is broken in TWO failure modes, not just the
  // round-19 advisory case:
  //   1. blockInstall=true → install was deliberately skipped.
  //   2. install was attempted but THREW (caught above, set
  //      installed=false). The catch surfaced a `Retry manually`
  //      hint, but the original code still ran `git init` on
  //      the no-lockfile tree — same dirty-repo / amend
  //      headache as the round-19 case.
  // Either way: if install was supposed to run AND didn't
  // succeed, skip git too and tell the user to retry. The
  // wouldHaveInstalled gate (round 21) still guards the
  // `--skip-install --git` honor case where no install was
  // attempted by design.
  const wouldHaveInstalled = !options.skipInstall && pm !== undefined;
  // Round 39 (Copilot, PR #99): pnpm 11 and bun on Windows have
  // been observed exiting non-zero AFTER writing both
  // `node_modules` and the lockfile. The round-35 gate keyed on
  // the throw alone, which silently dropped a `--git` user's
  // initial commit even though the bootstrap was effectively
  // complete.
  //
  // Round 39 follow-up (Codex P1, PR #99): falling back to
  // `existsSync(lockfile)` alone is too loose — a workspace-
  // subdir scaffold with a stale ancestor lockfile would let a
  // totally failed install pass the gate. Compare against the
  // pre-install snapshot so only a forward-moving mtime (or a
  // freshly created lockfile) counts as "install touched
  // something material on disk".
  //
  // Round 39 follow-up #2 (Codex P1, PR #99): mtime change
  // alone still admits a failed-mid-install case where the pm
  // rewrote the lockfile but errored BEFORE populating
  // `node_modules` (preinstall / install lifecycle hook
  // failure on an existing project). Pair the lockfile-changed
  // signal with `hasEnclosingNodeModules` so the recovery path
  // only fires when both artefacts are on disk — that matches
  // the round-39 safe case (pnpm 11 / bun-Windows
  // post-install exit, where `node_modules` is already
  // populated when the throw happens).
  const installSucceeded =
    !wouldHaveInstalled ||
    installed ||
    (lockfileChangedSince(cwd, pm, lockfileBefore) &&
      hasEnclosingNodeModules(cwd, pm));
  let gitInitSkipped = false;
  if (shouldInitGit && wouldHaveInstalled && blockInstall) {
    ui.log.info(
      "Skipping git init too — fix the advisory above first, then re-run this command so the lockfile lands in the initial commit.",
    );
    gitInitSkipped = true;
  } else if (shouldInitGit && !installSucceeded) {
    ui.log.info(
      `Skipping git init too — \`${pm} install\` failed, so the lockfile didn't land. Fix the install error first, then re-run this command.`,
    );
    gitInitSkipped = true;
  } else if (shouldInitGit) {
    await runGitInit(cwd);
  }

  const devCmd =
    pm && pm !== "npm" ? `${pm} arkor dev` : "npx arkor dev";
  // Round 39 (Copilot, PR #99): when git init was skipped (install
  // blocked or threw) but the user originally requested `--git`,
  // the closing outro must remind them to create the repo + initial
  // commit themselves once install succeeds. Without it, a `--git`
  // user following "Next: ..." verbatim ends up with install fixed
  // but no repository.
  //
  // Round 39 (Codex P2, PR #99): the commit message is wrapped in
  // SINGLE quotes — POSIX shells expand backticks inside double
  // quotes, so a copy-pasted `git commit -m "Initial commit from
  // \`arkor init\`"` would shell-execute `arkor init` instead of
  // committing. Single quotes preserve the backticks literally.
  const gitTail = gitInitSkipped
    ? ", then `git init && git add -A && git commit -m 'Initial commit from `arkor init`'`"
    : "";
  // Round 39 (Copilot, PR #99): the install-blocked branch already
  // told the user to fix the yarn-config advisory first; printing
  // the generic `Next: <pm> install` outro after that contradicts
  // the warning. Repeat the fix-first recovery instead so the
  // closing line stays consistent with the advisory above.
  if (wouldHaveInstalled && blockInstall) {
    const fixRetry = pm
      ? `\`${pm} install\``
      : MANUAL_INSTALL_HINT;
    ui.outro(
      `Next: fix the advisory above, then ${fixRetry}${gitTail}, then \`${devCmd}\``,
    );
    return;
  }
  // Round 39 (Copilot, PR #99): the outro must use the SAME
  // "effectively installed" signal as the git-init gate. Keying
  // on `installed` alone tells a recovered-install user (install
  // threw but lockfile is on disk) to run `<pm> install` again
  // even though we've already accepted the bootstrap as complete
  // and let git init proceed. `installSucceeded` captures both
  // the in-memory success and the on-disk recovery, so they stay
  // aligned.
  const treeIsReady = installSucceeded && wouldHaveInstalled;
  ui.outro(
    treeIsReady
      ? `Next: \`${devCmd}\`${gitTail}`
      : pm
        ? `Next: \`${pm} install\`${gitTail}, then \`${devCmd}\``
        : `Next: ${MANUAL_INSTALL_HINT}${gitTail}, then \`${devCmd}\``,
  );
}
