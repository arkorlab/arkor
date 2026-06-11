import { basename } from "node:path";

import {
  gitInitialCommit,
  install,
  isClaudeCode,
  isInGitRepo,
  lockfileChangedSince,
  nodeModulesChangedSince,
  sanitise,
  scaffold,
  snapshotLockfile,
  snapshotNodeModules,
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
   * pnpm: yarn / npm / bun ignore the workspace yaml, and `scaffold()`
   * skips `pnpm-workspace.yaml` emission entirely when an explicit non-pnpm
   * `--use-*` is set, so under those toolchains the flag is a **no-op**
   * (nothing is written, nothing is persisted). We still accept it
   * unconditionally for CLI symmetry; users switching to pnpm later need to
   * re-run with `--use-pnpm --allow-builds` to take effect. Round 40
   * (Copilot, PR #99) flagged the previous wording that implied
   * persistence across toolchain switches.
   */
  allowBuilds?: boolean;
  /**
   * Write `AGENTS.md` + `CLAUDE.md` to brief AI coding agents that arkor
   * post-dates their training data. Undefined falls through to the
   * scaffold default (off); `main.ts` resolves the CLI default-on so
   * `arkor init` matches `create-arkor`.
   */
  agentsMd?: boolean;
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
      "Directory is already inside a git repository. Skipping git init.",
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
      "Directory became a git repository during install. Skipping git init.",
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
        "Commit signing failed: created an unsigned commit. Re-sign with `git commit --amend -S` once your signing setup is fixed.",
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
  // Under CLAUDECODE=1 the action handler in `main.ts` has already gated
  // strict mode: if we reach `runInit`, either every flag is present or
  // `--yes` was passed. Force `skipWith` so the helpers never try to open
  // a clack prompt under a Claude Code TTY (which can't answer); the
  // other commands keep their pre-existing interactive semantics because
  // `isInteractive()` is no longer overridden globally.
  const bypassPrompts = options.yes || isClaudeCode();
  const projectName = await promptText({
    message: "Project name?",
    initialValue: options.name ?? defaultName,
    skipWith: bypassPrompts ? (options.name ?? defaultName) : undefined,
  });
  // An explicit `--template <id>` is authoritative: skip the prompt and use it as-is.
  const template = await promptSelect<TemplateId>({
    message: "Starter template?",
    initialValue: options.template ?? "triage",
    options: templateChoices(),
    skipWith: options.template ?? (bypassPrompts ? "triage" : undefined),
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
    agentsMd: options.agentsMd,
  });

  ui.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );
  // Surface non-fatal scaffolder advisories (currently: existing
  // `.yarnrc.yml` with `nodeLinker:` set to a value the arkor runtime
  // can't load through, yarn-berry merge into an existing project
  // where we declined to write `.yarnrc.yml` defensively, or
  // duplicate canonical blocks in an existing `AGENTS.md`). The
  // install step below also consults `blockInstall` and bows out
  // when yarn-config advisories fire: running `yarn install` against
  // an unfixed PnP setup produces no `node_modules` and leaves the
  // project broken, so install would be worse than useless.
  for (const warning of warnings) {
    ui.log.warn(warning);
  }

  // Resolve the git-init choice before kicking off install so the user can
  // walk away once they've answered every prompt; otherwise they'd sit at an
  // interactive question after a multi-minute `<pm> install`. Execution still
  // happens after install: the lockfile generated by the package manager
  // must land in the initial commit, otherwise the tree would be dirty right
  // after `--git` / `-y` and the bootstrap commit wouldn't be reproducible.
  const shouldInitGit = await decideGitInit(cwd, options);

  const pm = options.packageManager;

  let installed = false;
  // Round 40 (Copilot, PR #99): stash any `install()` throw so the
  // `Retry manually` hint can be deferred to AFTER the recovery
  // gate runs. pnpm 11 / bun-Windows have been observed exiting
  // non-zero AFTER writing both `node_modules` and the lockfile,
  // in which case the gate flips `installSucceeded` to true and
  // the outro omits the install step. Printing `Retry manually`
  // inline from the catch directly contradicted that recovered
  // branch's outcome.
  let installThrewError: string | undefined;
  // Round 40 follow-up #5 (Copilot, PR #99): defer the lockfile +
  // node_modules pre-install snapshots until we know an install
  // will actually fire. Both helpers walk ancestors and stat
  // files; running them under `--skip-install`, `pm === undefined`,
  // or `blockInstall=true` is wasted I/O whose result is never
  // consulted (the recovery gate only fires when install itself
  // threw). Snapshots are captured INSIDE the try-block, just
  // before `install()`, so the after-install diff still anchors
  // on the right pre-state.
  let lockfileBefore: ReturnType<typeof snapshotLockfile> | undefined;
  let nodeModulesBefore: ReturnType<typeof snapshotNodeModules> | undefined;
  if (!options.skipInstall && pm) {
    if (blockInstall) {
      // Round 17 (Copilot, PR #99): the yarn-config advisories above
      // tell the user to fix `.yarnrc.yml` before running `yarn
      // install`. Running install ourselves first would produce an
      // empty `node_modules` (yarn 4 PnP) and leave `arkor dev` /
      // `arkor train` broken: the install becomes worse than
      // useless. Skip and surface the manual-retry hint instead, so
      // the user fixes the config first and retries.
      ui.log.info(
        `Skipping install. Fix the advisory above first, then run: ${pm} install`,
      );
    } else {
      // Round 39 (Codex P1, PR #99): snapshot the closest-enclosing
      // lockfile + cwd `node_modules` BEFORE install so the
      // post-install gate can prove install actually changed
      // something on disk. Without the pre-snapshot, a workspace-
      // subdir scaffold with a stale ancestor lockfile would treat
      // any failed install as "lockfile landed" via `existsSync`
      // alone, letting the CLI run git init over an untouched
      // tree. Captured at the LAST safe moment (just before
      // `install()`) so unrelated branches don't pay the walk +
      // stat cost (round-40 follow-up #5).
      lockfileBefore = snapshotLockfile(cwd, pm);
      nodeModulesBefore = snapshotNodeModules(cwd);
      ui.log.step(`Installing dependencies with ${pm}`);
      try {
        await install(pm, cwd);
        installed = true;
      } catch (err) {
        // Surface the pm error itself immediately (visibility). The
        // `Retry manually` hint is DEFERRED to after the recovery
        // gate computes `installSucceeded` below; see the
        // `installThrewError` declaration above for the rationale.
        installThrewError = err instanceof Error ? err.message : String(err);
        ui.log.warn(installThrewError);
      }
    }
  }

  // Round 19 (Copilot, PR #99): when blockInstall is true AND
  // an install was actually going to run, skipping git init
  // preserves the "lockfile lands in the initial commit"
  // invariant; committing now would capture an empty
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
  // prescriptive command: point at the advisory and let the
  // user re-invoke with whatever they originally typed.
  // Round 35 (Copilot, PR #99): the lockfile-in-initial-commit
  // invariant is broken in TWO failure modes, not just the
  // round-19 advisory case:
  //   1. blockInstall=true → install was deliberately skipped.
  //   2. install was attempted but THREW (caught above, set
  //      installed=false). The catch surfaced a `Retry manually`
  //      hint, but the original code still ran `git init` on
  //      the no-lockfile tree: same dirty-repo / amend
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
  // `existsSync(lockfile)` alone is too loose: a workspace-
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
  // signal with a `node_modules` before/after diff so the
  // recovery path only fires when BOTH artefacts moved during
  // this install. The earlier `hasEnclosingNodeModules` static
  // check (round 39 follow-up #2 first attempt) false-
  // positived against ambient ancestor `node_modules` from a
  // prior root install; the snapshot/diff at cwd
  // specifically proves this install did the work, not a
  // hoisted parent install from earlier.
  // Round 40 (Copilot, PR #99): repeated re-flag of the
  // recovery gate. Earlier rounds used the on-disk artefact
  // diff (lockfile + `node_modules` both moved, gated on
  // pm-allowlist) to decide BOTH the git auto-run AND the
  // outro's "Next:" hint. Copilot flagged that auto-running git
  // on any non-zero pm exit is unsafe: even with the
  // pm-allowlist, a real lifecycle/postinstall failure on pnpm
  // or bun can satisfy "lockfile + node_modules changed" and
  // we'd silently commit a broken tree.
  //
  // We can't distinguish "benign non-zero exit"
  // (pnpm 11 `ERR_PNPM_IGNORED_BUILDS` once `allowBuilds:
  // { esbuild: false }` is in place, this is rare; bun-on-
  // Windows quirks) from "real lifecycle failure" without
  // parsing pm-specific stderr, and `install()` currently
  // uses `stdio: "inherit"`, so we don't capture it. The
  // honest fix is to split the signal:
  //
  //   - `installAttemptCompleted`: STRICT. The pm exited 0
  //     (or install was skipped by design). Used to decide
  //     whether to AUTO-RUN `git init` + initial commit. On
  //     any throw, this is `false` regardless of artefacts.
  //   - `installArtifactsLanded`: LENIENT. The pm threw, but
  //     for an allowlisted pm the lockfile + `node_modules`
  //     diff says the tree was populated. Used to:
  //       (a) Suppress the "Retry manually" inline (since the
  //           tree looks done) and instead suggest manual
  //           inspection + commit.
  //       (b) Drive the outro's "Next:" to point at `dev`
  //           rather than `<pm> install`, so a user whose
  //           install really did finish can pick up where
  //           they were.
  //
  // The user makes the final call on whether to commit. This
  // is the smallest change that addresses Copilot's concern
  // ("recovery should not treat install as successful for
  // git/outro purposes") while preserving the round-39 UX
  // benefit for users with a populated tree.
  const RECOVERY_ELIGIBLE_PMS: PackageManager[] = ["pnpm", "bun"];
  const installAttemptCompleted = !wouldHaveInstalled || installed;
  const installArtifactsLanded =
    installThrewError !== undefined &&
    pm !== undefined &&
    RECOVERY_ELIGIBLE_PMS.includes(pm) &&
    // The snapshots are taken at the same point install() is
    // about to fire, so if install threw they're necessarily
    // defined. The explicit !== undefined check narrows TS's
    // type to the non-undefined alias for the helpers below.
    lockfileBefore !== undefined &&
    nodeModulesBefore !== undefined &&
    lockfileChangedSince(cwd, pm, lockfileBefore) &&
    nodeModulesChangedSince(cwd, nodeModulesBefore);
  if (
    installThrewError !== undefined &&
    !installAttemptCompleted &&
    !installArtifactsLanded
  ) {
    ui.log.info(`Retry manually: ${pm} install`);
  }
  // Round 40 follow-up (Copilot, PR #99): when artefacts landed
  // despite the throw, the inline retry hint above is suppressed
  // because the skip-git branch below handles the user
  // messaging. But that branch only fires when `shouldInitGit`
  // is true. For users who passed `--skip-git` (or who are in a
  // non-interactive shell with no `--git` flag) the skip-git
  // branch never runs, leaving the user with NO surfacing of
  // the non-zero exit before the outro proceeds with "Next:
  // dev". Emit the recovered-artefacts guidance independently
  // of the git decision so the warning surfaces in every shape
  // of the run.
  if (installArtifactsLanded && !shouldInitGit) {
    ui.log.info(
      `\`${pm} install\` exited non-zero, but the lockfile and node_modules look populated. Inspect the tree before relying on the install; if the exit was real, fix and re-run.`,
    );
  }
  let gitInitSkipped = false;
  if (shouldInitGit && wouldHaveInstalled && blockInstall) {
    ui.log.info(
      "Skipping git init too. Fix the advisory above first, then re-run this command so the lockfile lands in the initial commit.",
    );
    gitInitSkipped = true;
  } else if (shouldInitGit && !installAttemptCompleted) {
    // Throw → never auto-run git (round 40 Copilot, PR #99).
    // Differentiate the message based on whether the on-disk
    // artefacts look populated. If they do, the user might want
    // to commit themselves after a quick inspection; if they
    // don't, the install genuinely failed.
    ui.log.info(
      installArtifactsLanded
        ? `Skipping git init: \`${pm} install\` exited non-zero, but the lockfile and node_modules look populated. If the install actually completed (pnpm 11 ignored-builds noise or bun-on-Windows quirks), inspect the tree and commit manually with the command in the outro below; otherwise fix the install error first and re-run.`
        : `Skipping git init too. \`${pm} install\` failed, so the lockfile didn't land. Fix the install error first, then re-run this command.`,
    );
    gitInitSkipped = true;
  } else if (shouldInitGit) {
    await runGitInit(cwd);
  }

  const devCmd = pm && pm !== "npm" ? `${pm} arkor dev` : "npx arkor dev";
  // Round 39 (Copilot, PR #99): when git init was skipped (install
  // blocked or threw) but the user originally requested `--git`,
  // the closing outro must remind them to create the repo + initial
  // commit themselves once install succeeds. Without it, a `--git`
  // user following "Next: ..." verbatim ends up with install fixed
  // but no repository.
  //
  // Round 40 (Codex P2, PR #99): the recovery hint must work when
  // copy-pasted into ANY shell (POSIX bash/zsh, cmd.exe, and
  // PowerShell). Single quotes are POSIX-only: cmd.exe treats them
  // as literal characters, so `git commit -m 'Initial commit ...'`
  // tokenizes on whitespace and fails with `pathspec` errors. Use
  // double quotes (universally honored) and drop the inner
  // `\`arkor init\`` backticks, since POSIX expands backticks
  // inside double quotes (would shell-execute `arkor init`). The
  // auto-commit path (Trainer.gitInitialCommit) keeps the
  // backticked message: that goes via spawn argv, not a shell.
  //
  // Round 40 follow-up (Copilot, PR #99): the command itself is
  // emitted WITHOUT surrounding markdown-style backticks. The
  // other outro tokens (`<pm> install`, `<pm> arkor dev`) keep
  // their decorative backticks because they're short identifiers
  // that users instinctively recognise as code labels and drop
  // when copying. The git-init chain is long enough that the
  // outer backticks visually merge with the rest of the prose,
  // making it likely the user copy-pastes them too. That breaks
  // in every supported shell: POSIX `\`...\`` triggers command
  // substitution (the shell tries to run the chain and capture
  // its output, then exec the empty result), PowerShell treats
  // \` as an escape character. Emit the command bare so even a
  // verbatim copy lands cleanly.
  //
  // Round 40 follow-up #3 (Codex P2, PR #99): no single
  // statement separator works across all four supported shells.
  // `&&` (chain-on-success) works in POSIX, cmd.exe, and PS 7+
  // but errors on PowerShell 5.1 (the Windows-default until
  // Win11 ships PS 7+ in-box). `;` works in POSIX, PS 5.1, and
  // PS 7+ but is a literal in cmd.exe (chain-on-success is
  // `&&`, sequential is `&`; `;` is treated as ordinary text).
  // Cycling between `&&` and `;` would break one of cmd.exe vs
  // PS 5.1 every time. Emit the three git commands on SEPARATE
  // LINES instead so the user copy-pastes each one
  // individually; every supported shell handles
  // newline-as-separator natively.
  const gitCmdLines: readonly string[] = [
    "git init",
    "git add -A",
    'git commit -m "Initial commit from arkor init"',
  ];
  // Round 39 (Copilot, PR #99): the install-blocked branch already
  // told the user to fix the yarn-config advisory first; printing
  // the generic `Next: <pm> install` outro after that contradicts
  // the warning. Repeat the fix-first recovery instead so the
  // closing line stays consistent with the advisory above.
  if (wouldHaveInstalled && blockInstall) {
    // `wouldHaveInstalled` proved `pm !== undefined` for the rest of
    // this branch, so the previous `pm ? ... : MANUAL_INSTALL_HINT`
    // ternaries collapsed to the truthy arm.
    const fixRetry = `\`${pm} install\``;
    if (gitInitSkipped) {
      // Multi-line outro: each git step on its own line so users
      // copy-paste them individually. See `gitCmdLines` above for
      // why no single chain separator works across the supported
      // shells.
      ui.outro(
        [
          `After fixing the advisory above, run:`,
          `  ${pm} install`,
          ...gitCmdLines.map((line) => `  ${line}`),
          `  ${devCmd}`,
        ].join("\n"),
      );
      return;
    }
    ui.outro(
      `Next: fix the advisory above, then ${fixRetry}, then \`${devCmd}\``,
    );
    return;
  }
  // Round 39 → Round 40 (Copilot, PR #99): the outro's "Next:"
  // hint uses the LENIENT signal so a user whose throw was the
  // documented benign kind (artefacts landed) sees `<pm> dev`
  // rather than being told to re-run install they just
  // completed. The git decision above used the strict signal
  // (we don't auto-commit on throw), but the outro is purely
  // informational and benefits from the on-disk evidence.
  //
  // Round 40 follow-up (Copilot, PR #99): when git was skipped
  // AND the tree is ready (recovered-artefacts path), order the
  // hint as `git init && commit`, then `dev`, not `dev, then
  // git`. The skip-git message says "commit manually with the
  // command in the outro below", so the outro must put the
  // commit command BEFORE the dev command, matching the natural
  // "init repo, then start working" sequence the user expects.
  // The previous form appended `gitTail` after `devCmd` and read
  // as "dev first, then git", inverting the implied ordering.
  const treeIsReady =
    (installAttemptCompleted || installArtifactsLanded) && wouldHaveInstalled;
  const installCmd = pm ? `\`${pm} install\`` : MANUAL_INSTALL_HINT;
  if (gitInitSkipped) {
    // Multi-line outro when git was skipped: each git step on its
    // own line, plus install (if needed) and dev. See
    // `gitCmdLines` above for why no single chain separator
    // works across the supported shells.
    const lines: string[] = ["Next:"];
    if (!treeIsReady)
      lines.push(`  ${pm ? `${pm} install` : MANUAL_INSTALL_HINT}`);
    for (const line of gitCmdLines) lines.push(`  ${line}`);
    lines.push(`  ${devCmd}`);
    ui.outro(lines.join("\n"));
    return;
  }
  const steps: string[] = [];
  if (!treeIsReady) steps.push(installCmd);
  steps.push(`\`${devCmd}\``);
  ui.outro(`Next: ${steps.join(", then ")}`);
}
