#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ClaudeCodeStrictExit,
  formatClaudeCodeMissingMessage,
  gitInitialCommit,
  install,
  isClaudeCode,
  isInGitRepo,
  lockfileChangedSince,
  missingClaudeCodeFlags,
  nodeModulesChangedSince,
  resolvePackageManager,
  snapshotLockfile,
  snapshotNodeModules,
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
  /**
   * `true` when the user explicitly passed `--allow-builds`. Threads through
   * to `scaffold()` so the emitted `pnpm-workspace.yaml#allowBuilds.esbuild`
   * is `true` instead of the secure-by-default `false`. Mirror of the same
   * field on `arkor init`'s `InitOptions`; see that interface for details.
   */
  allowBuilds?: boolean;
  /**
   * Write `AGENTS.md` + `CLAUDE.md` to brief AI coding agents that arkor is
   * newer than their training data. Defaults to true; `--no-agents-md` opts out.
   */
  agentsMd: boolean;
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
 * Shell-quote a path so the `cd ${path}` recovery hints survive
 * paths with spaces or metacharacters. Round-39 Copilot review:
 * `create-arkor "My App"` would otherwise emit a copy-paste-
 * broken `cd My App && pnpm install`.
 *
 * Skips quoting for the common safe case (alphanumerics + a few
 * unambiguous extras like `-_./+@:,`) so the printed hint stays
 * clean for typical project names.
 *
 * Quoting style is platform-aware (round-39 Codex P2 / Copilot):
 *
 *   - POSIX (Linux / macOS): single quotes. Embedded `'` is
 *     escaped via the standard `'\''` close-literal-open
 *     sequence — the bytes `'`, `\`, `'`, `'` parse as
 *     end-quote, literal `'`, start-quote.
 *   - Windows (cmd.exe / PowerShell): double quotes with a
 *     MIXED escape strategy — there is no single quoting form
 *     that's clean for both shells, so we pick the safer
 *     escape per metacharacter:
 *       * `` ` `` (backtick) and `$`: PS-style backtick prefix
 *         (`` ` `` → `` `` ``, `$` → `` `$ ``). PowerShell
 *         interpolates `$VAR` / `$()` inside double quotes, so
 *         a path containing those would let a copy-pasted
 *         `cd "..." && <pm> install` evaluate a subexpression
 *         when pasted into a PS prompt (round-39 Copilot
 *         flagged this as the copy-paste injection vector). In
 *         cmd these chars are literal so the backtick-prefix
 *         is just a cosmetic mismatch.
 *       * `\` and `"`: backslash-style (`\` → `\\`, `"` → `\"`).
 *         These match the `_setargv` / msvcrt argv parsing
 *         convention used when the quoted path is forwarded to
 *         a child program from cmd. PS doesn't honour `\` as an
 *         escape inside double quotes (the literal text is
 *         what `Set-Location` sees), but `cd "C:\\foo\\bar"`
 *         still resolves to `C:\foo\bar` because NTFS
 *         normalizes adjacent separators. The `"` escape is
 *         defensive-only: NTFS / Win32 path APIs reject `"` as
 *         a filename character, so a path that round-trips
 *         through `readdir` / `resolve` can't actually contain
 *         one. We still emit `\"` so the printed string parses
 *         correctly as a quoted token if a hypothetical caller
 *         ever hands us a non-path string with embedded
 *         quotes; under real `cdTarget` values from
 *         `options.dir ?? name` the branch is unreachable.
 *       * `%`: NOT escaped — there is no transparent escape for
 *         `%VAR%` inside double quotes in interactive `cmd.exe`
 *         (`^%` only suppresses expansion in batch files, not
 *         at the prompt; `%%` becomes literal `%%` outside
 *         batch). PowerShell treats `%` as literal in double
 *         quotes, so PS users see correct hints. cmd users
 *         with a path like `My%Project%App` would see
 *         `%Project%` substituted with the env var of that
 *         name (or left as-is if undefined on Windows 10+).
 *         Same level of edge case as the other documented
 *         mismatches; round-39 Copilot flagged it explicitly.
 *     `cmd.exe` users with paths containing `` ` ``, `$`, or
 *     `%` see a slightly mangled but not-injection-vector hint
 *     (the `%`-on-cmd case is mitigated separately by
 *     `buildCdLine`, which switches to a PowerShell-only form
 *     when `%` is present). Paths with these metachars are
 *     vanishingly rare in practice; the single-line cd-recovery
 *     print is a pragmatic compromise, since emitting separate
 *     cmd / PS lines would more than double the closing summary
 *     length for a hazard most users will never hit.
 */
export function shellQuoteIfNeeded(value: string): string {
  // Round 40 follow-up (Copilot, PR #99): a leading dash makes
  // POSIX shells, PowerShell, AND cmd.exe treat the argument as
  // an option/switch even when QUOTED. `cd '-foo'` and
  // `cd "-foo"` both still fail with "invalid option" in bash,
  // because the shell strips the quotes before `cd` sees the
  // argument. The portable fix is path-disambiguation: prefix
  // a relative `-`-starting path with `./` (or `.\\` on
  // Windows). `./-foo` and `.\-foo` are unambiguous filesystem
  // paths the shell hands to `cd` verbatim, sidestepping the
  // option parser entirely. Absolute paths never start with `-`,
  // so this is a no-op for them. Apply BEFORE the safe-unquote
  // and quoting paths below so a quoted `-`-prefixed name also
  // gets the prefix (e.g. a path with both leading dash and a
  // space).
  if (value.startsWith("-")) {
    const prefix = process.platform === "win32" ? ".\\" : "./";
    value = `${prefix}${value}`;
  }
  // Safe-unquote criteria: only alphanumerics + a small set of
  // unambiguous extras (`-_./+@:,`). After the leading-dash
  // disambiguation above, `value` no longer starts with `-`
  // even if the user-supplied path did.
  if (/^[a-zA-Z0-9_./+@:,-]+$/.test(value)) return value;
  if (process.platform === "win32") {
    // Order matters: backtick first (it's the PS escape
    // character for the others, so escaping it first prevents
    // double-decoding), then the metachars it protects (`$`,
    // `"`). Backslash escape is independent — it's for
    // `_setargv` / msvcrt argv parsing when the quoted path
    // is forwarded to a child program.
    const escaped = value
      .replace(/`/g, "``")
      .replace(/\$/g, "`$")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * True when the platform is Windows AND `cdTarget` contains a
 * `%` that would trigger `cmd.exe`'s `%VAR%` expansion. There
 * is no transparent escape for `%VAR%` at an interactive cmd
 * prompt (`^%` works only inside batch files, `%%` only inside
 * batch; neither helps interactively), so a `cd "<path>"`
 * emitted into cmd expands the `%`-segments and, worst case,
 * opens a copy-paste injection vector if the env var contains
 * quotes or `&`. `buildCdLine` falls back to a PowerShell-only
 * single-quoted form for this case.
 */
function isWindowsPercentPath(cdTarget: string): boolean {
  return process.platform === "win32" && cdTarget.includes("%");
}

/**
 * Build a copy-pasteable `cd <path>` line. POSIX uses single
 * quotes, Windows uses double quotes (via `shellQuoteIfNeeded`),
 * EXCEPT when the path triggers `isWindowsPercentPath`: then
 * fall back to a PowerShell-only single-quoted form. PS treats
 * `%` as a literal inside single quotes; `cmd.exe` users with
 * `%`-bearing paths can't safely `cd` to them under any quoting
 * form anyway, so trading cross-shell coverage for elimination
 * of the expansion hazard is the conservative choice.
 *
 * Used by the multi-line outro (which prints `cd` on its own
 * line). Recovery hints that previously chained `cd && <pm>
 * install` were reworded to prose `<pm> install in <path>` in
 * round-40 follow-up #4 (no chain separator survives PS 5.1 +
 * cmd.exe simultaneously), so this helper is no longer used by
 * a chain builder; it stays single-purpose for the outro `cd`
 * line.
 */
export function buildCdLine(cdTarget: string): string {
  if (isWindowsPercentPath(cdTarget)) {
    // PS single-quote escape: doubled single quote `''`.
    return `cd '${cdTarget.replace(/'/g, "''")}'`;
  }
  return `cd ${shellQuoteIfNeeded(cdTarget)}`;
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

  // Under CLAUDECODE=1 the action handler below has already gated strict
  // mode: by the time we get here either every flag is present or `--yes`
  // was passed. Treat CLAUDECODE as an implicit "skip prompts" so a Claude
  // Code TTY (which can't answer clack) never opens a real prompt; other
  // CLIs keep their pre-existing interactive semantics because
  // `isInteractive()` is no longer overridden globally.
  if (!options.yes && !isClaudeCode() && isInteractive()) {
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
  const { files, warnings, blockInstall } = await scaffold({
    cwd,
    name,
    template,
    packageManager: pm,
    allowBuilds: options.allowBuilds,
    agentsMd: options.agentsMd,
  });
  spin.stop("Done");

  clack.note(
    files.map((f) => `${f.action.padEnd(8)} ${f.path}`).join("\n"),
    "Files",
  );
  // Surface non-fatal scaffolder advisories (see arkor init for the
  // mirror of this loop and the rationale). The install step below
  // also consults `blockInstall` and bows out when yarn-config
  // advisories fire: running `yarn install` against an unfixed PnP
  // setup produces no `node_modules` and leaves the project broken.
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
  // node_modules pre-install snapshots until we know install will
  // actually fire (see `arkor init` for the same fix and the full
  // rationale). Captured inside the install-attempted branch only,
  // just before `install()`, so the after-install diff still
  // anchors on the right pre-state.
  let lockfileBefore: ReturnType<typeof snapshotLockfile> | undefined;
  let nodeModulesBefore: ReturnType<typeof snapshotNodeModules> | undefined;
  if (!options.skipInstall && pm) {
    if (blockInstall) {
      // Round 17 (Copilot, PR #99): the yarn-config advisories above
      // tell the user to fix `.yarnrc.yml` before running `yarn
      // install`. Running install ourselves first would produce an
      // empty `node_modules` (yarn 4 PnP) and leave `arkor dev` /
      // `arkor train` broken — the install becomes worse than
      // useless. Skip and surface the manual-retry hint instead.
      // Round 40 follow-up #4 (Codex P2, PR #99): no shell-chain
      // separator works across all four supported shells (`&&`
      // breaks PS 5.1; `;` is literal in cmd.exe). Sidestep the
      // chain entirely by describing the cd as prose: the user
      // can `cd` to the path with whatever syntax their shell
      // uses, then run the single command separately. Path is
      // wrapped in backticks for code styling so the prose stays
      // readable.
      const retry = inPlace
        ? `\`${pm} install\``
        : `\`${pm} install\` in \`${cdTarget}\``;
      clack.log.info(
        `Skipping install — fix the advisory above first, then run ${retry}.`,
      );
    } else {
      // Round 39 (Codex P1, PR #99): snapshot the closest-enclosing
      // lockfile + cwd `node_modules` BEFORE install so the post-
      // install recovery gate can prove install actually changed
      // something on disk. See `arkor init` for the full rationale
      // and the round-40 follow-up #5 timing fix (capture at the
      // LAST safe moment, just before `install()`).
      lockfileBefore = snapshotLockfile(cwd, pm);
      nodeModulesBefore = snapshotNodeModules(cwd);
      clack.log.step(`Installing dependencies with ${pm}`);
      try {
        await install(pm, cwd);
        installed = true;
      } catch (err) {
        // Surface the pm error itself immediately (visibility). The
        // `Retry manually` hint is DEFERRED to after the recovery
        // gate computes `installSucceeded` below; see the
        // `installThrewError` declaration above for the rationale.
        installThrewError =
          err instanceof Error ? err.message : String(err);
        clack.log.warn(installThrewError);
      }
    }
  }

  // Round 19 (Copilot, PR #99): when blockInstall is true AND
  // an install was actually going to run, skipping git init
  // preserves the "lockfile lands in the initial commit"
  // invariant.
  //
  // Round 21 (Codex P2, PR #99): the rationale only applies when
  // install was actually going to run. If the user explicitly
  // passed `--skip-install`, no install was happening anyway,
  // there's no lockfile to wait for, and `--git`/`-y` is an
  // explicit request we shouldn't second-guess. Same goes for
  // `pm === undefined`. Gate the skip on "install would have
  // run".
  //
  // Round 21 (Copilot, PR #99): the recovery hint used to
  // prescribe `create-arkor` as the rerun command, but real
  // users invoke this via `npm create` / `pnpm create` /
  // `yarn create` / `bun create` (the `create-arkor` bin
  // usually isn't on PATH directly), and the hint dropped any
  // flags the user originally passed (`--use-yarn` / `--git` /
  // `--name` / etc). Drop the prescriptive command — point at
  // the advisory and let the user re-invoke with whatever they
  // originally typed.
  // Round 35 (Copilot, PR #99): the lockfile-in-initial-commit
  // invariant is broken in TWO failure modes, not just the
  // round-19 advisory case. install can also THROW (caught above,
  // sets `installed=false` + surfaces a manual-retry hint). In
  // that case the original code still ran `git init` on the
  // no-lockfile tree — same dirty-repo / amend headache as the
  // round-19 case. Skip git in both modes; the
  // wouldHaveInstalled gate (round 21) still honors the
  // `--skip-install --git` no-install-attempted case.
  const wouldHaveInstalled = !options.skipInstall && pm !== undefined;
  // Round 39 (Copilot, PR #99): mirror of `arkor init`'s
  // lockfile-on-disk fallback. pnpm 11 and bun on Windows can
  // exit non-zero AFTER writing both `node_modules` and the
  // lockfile, so treating the throw alone as "install failed"
  // silently dropped the requested initial commit even when the
  // bootstrap was effectively complete.
  //
  // Round 39 follow-up (Codex P1, PR #99): compare against the
  // pre-install snapshot rather than `existsSync` alone — a
  // workspace-subdir scaffold has a stale ancestor lockfile, so
  // the loose existence check would treat a totally failed
  // install as "lockfile landed" and proceed with `git init`
  // over an untouched tree.
  //
  // Round 39 follow-up #2 (Codex P1, PR #99): pair the
  // lockfile-changed signal with a `node_modules` before/after
  // diff so a preinstall / install-hook failure that rewrote
  // the lockfile but never populated `node_modules` doesn't
  // slip through, AND so an ambient ancestor `node_modules`
  // (monorepo subdir) doesn't false-positive the gate. See
  // `arkor init` for the full rationale.
  // Round 40 (Copilot, PR #99) — see `arkor init`'s mirror of
  // this comment for the full rationale. Split the signal:
  //
  //   - `installAttemptCompleted` (strict): drives the auto-git
  //     decision. On any throw, false regardless of artefacts.
  //     Closes the "real lifecycle failure on pnpm/bun satisfies
  //     the diff" hazard Copilot kept re-flagging — we never
  //     auto-commit on throw.
  //   - `installArtifactsLanded` (lenient): drives the outro's
  //     "Next:" hint and differentiates the skip-git message
  //     between "looks populated, inspect & commit manually"
  //     and "real failure, fix & re-run".
  const RECOVERY_ELIGIBLE_PMS: Array<PackageManager> = ["pnpm", "bun"];
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
    clack.log.info(
      inPlace
        ? `Retry manually: \`${pm} install\`.`
        : `Retry manually: run \`${pm} install\` in \`${cdTarget}\`.`,
    );
  }
  // Round 40 follow-up (Copilot, PR #99): mirror of arkor init's
  // `installArtifactsLanded && !shouldInitGit` branch. Without
  // this, a `--skip-git` user whose install threw with artefacts
  // landed sees no warning before the outro proceeds with "Next:
  // dev" — silently treating the non-zero exit as fine. Surface
  // the recovered-artefacts guidance independently of git so the
  // warning appears in every shape of the run.
  if (installArtifactsLanded && !shouldInitGit) {
    clack.log.info(
      `\`${pm} install\` exited non-zero, but the lockfile and node_modules look populated. Inspect the tree before relying on the install; if the exit was real, fix and re-run.`,
    );
  }
  // Round 39 (Copilot, PR #99): the previous "re-run this command"
  // hint is only safe when re-invoking would actually merge into
  // the same target. With no `[dir]` argument, `run()` derives a
  // fresh subdir and the occupied-directory guard at the top of
  // `run()` aborts on re-run instead of finishing the bootstrap.
  // Tell those users to recover inside the existing directory; for
  // explicit `[dir]` (and the `.` in-place case), the guard
  // doesn't fire, so re-run still works.
  const reRunIsSafe = options.dir !== undefined;
  const recoverInDir = inPlace
    ? `\`${pm} install\` (then \`git init\` + commit)`
    : `\`${pm} install\` in \`${cdTarget}\` (then \`git init\` + commit)`;
  let gitInitSkipped = false;
  if (shouldInitGit && wouldHaveInstalled && blockInstall) {
    clack.log.info(
      reRunIsSafe
        ? "Skipping git init too — fix the advisory above first, then re-run this command so the lockfile lands in the initial commit."
        : `Skipping git init too — fix the advisory above, then run ${recoverInDir} to finish the bootstrap.`,
    );
    gitInitSkipped = true;
  } else if (shouldInitGit && !installAttemptCompleted) {
    // Throw → never auto-run git (round 40 Copilot, PR #99).
    // Differentiate the message based on whether artefacts
    // look populated. Mirror of arkor init's skip-git branch;
    // the `reRunIsSafe` axis is create-arkor-specific (the
    // auto-derived subdir's occupied-directory guard).
    clack.log.info(
      installArtifactsLanded
        ? `Skipping git init — \`${pm} install\` exited non-zero, but the lockfile and node_modules look populated. If the install actually completed (pnpm 11 ignored-builds noise or bun-on-Windows quirks), inspect the tree and commit manually with the command in the outro below; otherwise fix the install error first${reRunIsSafe ? " and re-run this command" : ` and run ${recoverInDir} to finish the bootstrap`}.`
        : reRunIsSafe
          ? `Skipping git init too — \`${pm} install\` failed, so the lockfile didn't land. Fix the install error first, then re-run this command.`
          : `Skipping git init too — \`${pm} install\` failed. Fix the install error, then run ${recoverInDir} to finish the bootstrap.`,
    );
    gitInitSkipped = true;
  } else if (shouldInitGit) {
    await runGitInit(cwd);
  }

  // Round 39 → Round 40 (Copilot, PR #99): the outro's "Next:"
  // hint uses the LENIENT signal (artefacts landed counts as
  // "tree is ready") so a user whose throw was the benign kind
  // doesn't get told to re-run install they just completed. The
  // git decision above used the strict signal — we never
  // auto-commit on throw — but the outro is informational and
  // benefits from the on-disk evidence. `wouldHaveInstalled`
  // still pivots `--skip-install` / no-pm users to a manual
  // install step.
  const treeIsReady =
    (installAttemptCompleted || installArtifactsLanded) && wouldHaveInstalled;
  const installLine = treeIsReady
    ? null
    : pm
      ? `  ${pm} install`
      : `  ${MANUAL_INSTALL_HINT}`;
  const devLine =
    pm && pm !== "npm" ? `  ${pm} arkor dev` : `  npx arkor dev`;
  // Round 39 (Copilot, PR #99): when git init was skipped (install
  // blocked or threw) but the user originally requested `--git`,
  // remind them in the closing outro that they still need to
  // create the repo + initial commit themselves once install
  // succeeds. Without this step, a `--git` user following the
  // outro verbatim ends up with the install fixed but no repo.
  // Round 40 (Codex P2, PR #99): the recovery hint must survive
  // copy-paste into ANY shell (POSIX bash/zsh, cmd.exe, and
  // PowerShell). Single quotes are POSIX-only: cmd.exe treats
  // them as literal characters, so the previous
  // `git commit -m 'Initial commit from Create Arkor'` form
  // tokenized on whitespace on Windows and produced `pathspec`
  // errors. Double quotes are universally honored as quote
  // delimiters. The current message has no metachars (no `$`,
  // no backticks), so POSIX shells won't expand anything inside
  // them either, so it's safe everywhere.
  //
  // Round 40 follow-up #3 (Codex P2, PR #99): no single
  // statement separator works across all four supported shells
  // (`&&` chokes PowerShell 5.1; `;` is literal in cmd.exe).
  // Emit the three git commands on SEPARATE LINES so each one
  // copy-pastes cleanly under any shell. Mirror of `arkor
  // init`'s identical fix; see init.ts for the full rationale.
  const gitLines: readonly string[] = gitInitSkipped
    ? [
        `  git init`,
        `  git add -A`,
        `  git commit -m "Initial commit from Create Arkor"`,
      ]
    : [];
  // Round 39 (Copilot, PR #99): the install-blocked branch told
  // the user to fix the yarn-config advisory before running
  // install. Printing the generic `<pm> install` line in the
  // closing outro right after that contradicts the warning and
  // can lead users straight back into the same broken install.
  //
  // Round 40 (Copilot, PR #99): the previous fix prepended a
  // `  # Fix the advisory above first, then:` line inside the
  // multi-line block, but `#` is NOT a comment in `cmd.exe` —
  // pasting that line at a cmd prompt errors with `'#' is not
  // recognized as an internal or external command`. There's no
  // portable comment syntax across cmd / PowerShell / bash, so
  // instead of a fake-comment row, the advisory branch swaps
  // the outro's intro line ("Next steps:") for a sentence that
  // names the prerequisite ("After fixing the advisory above,
  // finish the bootstrap with:"). Prose-with-colon as the lead
  // line is the same shape as the default branch and won't be
  // mistaken for a command. The two earlier `clack.log.info`
  // advisories ("Skipping install — fix the advisory above
  // first, ...", "Skipping git init too — fix the advisory
  // above first, ...") still anchor the warning prominently
  // before the outro lands.
  const outroIntro =
    wouldHaveInstalled && blockInstall
      ? `After fixing the advisory above, finish the bootstrap with:`
      : `Next steps:`;

  clack.outro(
    [
      outroIntro,
      ...(inPlace ? [] : [`  ${buildCdLine(cdTarget)}`]),
      ...(installLine ? [installLine] : []),
      ...gitLines,
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
  .option(
    "--allow-builds",
    "opt esbuild's postinstall script into running on `pnpm install` (pnpm-only; default: deny — pnpm 11 errors on ignored builds and the scaffold writes `allowBuilds: { esbuild: false }` to silence it)",
  )
  .option(
    "--agents-md",
    "include AGENTS.md and CLAUDE.md to guide AI coding agents (default)",
  )
  .option("--no-agents-md", "skip generating AGENTS.md and CLAUDE.md")
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
        allowBuilds?: boolean;
        // Commander v13 leaves this undefined unless one of --agents-md /
        // --no-agents-md was passed; the action treats undefined as the
        // default-on value.
        agentsMd?: boolean;
      },
    ) => {
      if (opts.git && opts.skipGit) {
        throw new Error("Pick one of --git / --skip-git, not both.");
      }
      // Commander treats `--agents-md` and `--no-agents-md` as the same
      // option (last-wins), so it will not surface a conflict on its own.
      // Mirror the explicit `--git` / `--skip-git` check by inspecting raw
      // argv: passing both is almost always a mistake — refuse early
      // instead of silently honouring whichever came last. Stop scanning
      // at the POSIX `--` end-of-options sentinel so a positional `[dir]`
      // that happens to start with `--` (e.g. `create-arkor --agents-md
      // -- --no-agents-md`) is not misclassified as a conflicting flag.
      const sentinelIdx = process.argv.indexOf("--");
      const flagsArgv =
        sentinelIdx === -1
          ? process.argv
          : process.argv.slice(0, sentinelIdx);
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
          dir,
          agentsMd: agentsMdSpecified ? opts.agentsMd ?? true : undefined,
          requireProjectName: true,
        });
        if (missing.length > 0) {
          process.stderr.write(
            formatClaudeCodeMissingMessage("create-arkor", missing),
          );
          // Throw (don't `process.exit`) so the outer `program.parseAsync`
          // catch block recognises this sentinel and exits silently. The
          // "create-arkor failed:" prefix it normally adds would double up
          // on our already-printed missing-flags block.
          throw new ClaudeCodeStrictExit();
        }
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
        allowBuilds: opts.allowBuilds,
        // Commander v13 leaves opts.agentsMd undefined when no flag is
        // passed (it doesn't auto-default --no-foo to `foo: true`). Default
        // to on; only explicit `--no-agents-md` (which sets `false`) opts out.
        agentsMd: opts.agentsMd !== false,
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
    // The strict-mode validator throws this sentinel after writing the
    // missing-flags block; exit silently so the `create-arkor failed:`
    // prefix below doesn't double up on the already-printed message.
    //
    // Use `process.exitCode` for the strict path (not `process.exit`):
    // Node then lets the event loop drain naturally so the multi-line
    // stderr block flushes on piped stdio. Generic failures still go
    // through `process.exit(1)` because `run()` may have started a
    // `clack.spinner()` whose internal interval would otherwise keep
    // the event loop alive past the catch and stall the exit; a forced
    // exit is safer there than waiting for unknown UI resources to
    // tidy up (PR #141 review).
    if (err instanceof ClaudeCodeStrictExit) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `create-arkor failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
