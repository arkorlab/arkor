import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  /**
   * The child's final exit code, or `-1` if the child was terminated by a
   * signal (close event with `code === null`). Use `signal` to disambiguate
   * those two cases — see ENG-632 retry policy in `runCli`.
   */
  code: number;
  /**
   * The signal name (e.g. `"SIGKILL"`, `"SIGTERM"`, `"SIGSEGV"`) when the
   * child was terminated by a signal, otherwise `null`. Mirrors the
   * `signal` argument of Node's `ChildProcess` close event.
   */
  signal: NodeJS.Signals | null;
  /**
   * Wall-clock milliseconds from spawn to the `close` event. Used by the
   * ENG-632 SIGKILL retry guard to distinguish a startup-time runner kill
   * (observed at ~104 ms) from a kill that arrived after the CLI had
   * already done meaningful filesystem work — the latter would leave a
   * dirty `cwd` that retrying over could turn into a false positive.
   */
  elapsedMs: number;
  stdout: string;
  stderr: string;
  dir: string;
}

/**
 * Upper bound on the elapsed time (in milliseconds) for a SIGKILL'd run
 * to still qualify for retry. Calibrated from the observed PR #104 flake
 * (~104 ms, during the bin's `--experimental-strip-types` self-re-exec)
 * with ~3× headroom, and held well under the ~600–1200 ms a clean
 * `arkor init --skip-install --skip-git` takes to scaffold (see
 * `vitest.config.ts`'s `testTimeout` rationale). A SIGKILL past this
 * cutoff most likely landed *after* scaffold started writing files
 * (or much later, e.g. mid-`pnpm install`), at which point the `cwd`
 * is no longer pristine and a retry could mask the real failure, pass
 * spuriously against the merged-in-place tree, or fail with a different
 * error — all of which are worse than letting the original failure
 * surface.
 */
const SIGKILL_RETRY_MAX_MS = 300;

/**
 * Pure decision function for the ENG-632 retry gate, factored out so it
 * can be exercised by `spawn-cli.test.ts` without mocking
 * `node:child_process` or `process.platform`. All inputs are explicit so
 * a future refactor that accidentally widens or narrows the gate fails
 * the matrix tests rather than silently changing behaviour.
 */
export function shouldRetryAfterSigkill(
  result: RunResult,
  platform: NodeJS.Platform,
  isCI: boolean,
): boolean {
  return (
    result.signal === "SIGKILL" &&
    result.elapsedMs < SIGKILL_RETRY_MAX_MS &&
    platform === "darwin" &&
    isCI
  );
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Spawn a CLI binary as a Node child in `cwd`, capture stdio, return on exit.
 *
 * - `process.execPath` is used so we don't depend on `chmod +x dist/bin.mjs`
 *   on CI runners or on Windows shebang handling.
 * - `CI=1` makes both `bin.ts`'s and `prompts.ts`'s `isInteractive()` return
 *   false, so prompts short-circuit instead of reading stdin (we leave stdin
 *   ignored).
 * - `npm_config_user_agent: ""` forces `resolvePackageManager()` to return
 *   `undefined` unless the test passes `--use-*`. That makes the "manual
 *   install hint" branch reachable.
 * - `GIT_AUTHOR_*` / `GIT_COMMITTER_*` are pinned so the CLI's internal
 *   `git commit` succeeds even when the host (CI runners, fresh containers)
 *   has no `user.name` / `user.email` configured.
 *
 * ENG-632: macOS GitHub Actions runners occasionally SIGKILL the spawned
 * child during startup under load — the `close` event then fires with
 * `code === null` and `signal === "SIGKILL"` at ~100 ms, well before
 * scaffold/install/git work begins. Same invocation passes on rerun and
 * on every other matrix slot, so it's a runner artefact rather than a
 * regression. We retry exactly once and only when ALL of the following
 * hold (see `shouldRetryAfterSigkill`):
 *
 *   (a) we're on macOS — only platform that has produced the symptom,
 *   (b) the previous attempt's `signal === "SIGKILL"`,
 *   (c) the previous attempt's `elapsedMs < SIGKILL_RETRY_MAX_MS` —
 *       distinguishes a startup-time runner kill from a SIGKILL that
 *       arrived after the CLI had already started writing files (e.g.
 *       OOM mid-`pnpm install`), where retrying in the dirty `cwd`
 *       could mask the real failure or pass spuriously,
 *   (d) `process.env.CI` is set — local Mac developers debugging
 *       intermittent crashes get one-shot failures rather than silent
 *       retries that would hide the bug they're chasing.
 *
 * SIGTERM / SIGABRT / SIGSEGV / SIGBUS — i.e. the CLI itself crashed —
 * are NOT retried; same for any non-zero exit code (assertion-driven
 * failures, broken pm, real CLI bugs). Those still surface on the first
 * run on every platform.
 *
 * `cwd` handling: even with a tight elapsed-ms gate, the bin can reach
 * `scaffold()` and start writing `package.json` / `src/arkor/*` before
 * the SIGKILL lands — so attempt 2 in the same `cwd` could pass
 * spuriously against partial scaffold state or fail for the wrong
 * reason. We dodge that with a path-set snapshot:
 *
 *   1. Walk `cwd` recursively before attempt 1 and remember every
 *      relative path that already exists (test pre-seeded state, e.g.
 *      `arkor-init.test.ts`'s `git init` setup or `arkor-whoami.test.ts`'s
 *      seeded credentials).
 *   2. If we decide to retry, walk `cwd` again and `rmSync` everything
 *      *not* in the snapshot. Pre-seeded state survives intact;
 *      partially-written scaffold artefacts get cleared so attempt 2
 *      starts from the same baseline as attempt 1.
 *
 * Limitation: if attempt 1 *modified* a pre-seeded file in place
 * (rather than adding new ones), the modification persists into attempt
 * 2. The CLI's own scaffolders are idempotent — `package.json` patches
 * are no-ops on already-patched state, every other writer either creates
 * (`fs.writeFile` on a path that wasn't there) or keeps (`fs.existsSync`
 * short-circuit) — so this is acceptable in practice. A full
 * snapshot/restore (copying contents to a sibling temp dir) would handle
 * that edge case but at much higher cost on every run.
 *
 * Successful retries are logged to stderr so the runner-flake rate is
 * inspectable in CI logs (otherwise a steadily worsening environment
 * would silently turn into "tests still passing" until the second
 * attempt also starts SIGKILLing).
 */
export async function runCli(
  binPath: string,
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const cwdSnapshot = snapshotCwdPaths(cwd);
  let result = await runCliOnce(binPath, argv, cwd, extraEnv);
  if (
    shouldRetryAfterSigkill(result, process.platform, Boolean(process.env.CI))
  ) {
    process.stderr.write(
      `[runCli] retrying after SIGKILL at ${result.elapsedMs}ms (${binPath} ${argv.join(" ")})\n`,
    );
    removeNewlyAddedPaths(cwd, cwdSnapshot);
    result = await runCliOnce(binPath, argv, cwd, extraEnv);
  }
  return result;
}

/**
 * Recursively list every path inside `cwd` (one entry per file *and*
 * directory), keyed by `cwd`-relative path with forward-slash separators
 * for cross-platform comparability. Used by `runCli` to remember the
 * pre-attempt-1 baseline so a retry can selectively undo whatever the
 * killed first attempt added without clobbering pre-seeded test state.
 *
 * Errors are swallowed: a non-existent or unreadable `cwd` returns an
 * empty set, which makes the subsequent `removeNewlyAddedPaths` walk a
 * no-op. A real spawn failure in `runCliOnce` surfaces to the caller.
 */
function snapshotCwdPaths(cwd: string): Set<string> {
  const paths = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      paths.add(rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(cwd, "");
  return paths;
}

/**
 * Walk `cwd` and `rmSync` anything whose relative path isn't in
 * `baseline`. Children of a baseline directory are recursed into so a
 * pre-existing `cwd/.git/` keeps its `HEAD` etc. while `cwd/package.json`
 * (newly written by the killed attempt) gets removed. Mirrors the
 * forward-slash relpath format `snapshotCwdPaths` produces.
 */
function removeNewlyAddedPaths(cwd: string, baseline: Set<string>): void {
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (!baseline.has(rel)) {
        rmSync(abs, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) walk(abs, rel);
    }
  };
  walk(cwd, "");
}

function runCliOnce(
  binPath: string,
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<RunResult> {
  // `pnpm test` propagates the workspace's pnpm config to children as
  // `npm_config_*` / `pnpm_config_*` env vars (e.g. minimumReleaseAge from
  // pnpm-workspace.yaml becomes `npm_config_minimum_release_age`). Inside
  // an e2e test that scaffolds a *fresh* project in /tmp and runs `pnpm
  // install`, those leak through and apply the workspace's policy to a
  // brand-new tree — most painfully, freshly-published `arkor` versions
  // get blocked by minimumReleaseAge. Strip them so the spawned CLI sees
  // a clean user shell.
  //
  // The match is case-insensitive on purpose: Windows env-var names are
  // case-insensitive (CreateProcessW deduplicates by uppercased key), so
  // the parent can hand us `NPM_CONFIG_USER_AGENT` while we expect
  // `npm_config_user_agent`. A case-sensitive prefix check would let the
  // upper-case variant leak through, which on Windows then collides with
  // our explicit `npm_config_user_agent: ""` override below — Windows
  // picks one of the duplicates non-deterministically and the spawned
  // CLI has historically seen pnpm's UA, defeating the hermetic
  // `detectPackageManager()` path.
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("npm_config_") || lower.startsWith("pnpm_config_")) {
      continue;
    }
    cleanEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
    // Mirror an extraEnv-provided HOME onto USERPROFILE so the spawned
    // CLI's `os.homedir()` resolves to the test temp dir on every OS:
    // POSIX consults HOME, Windows consults USERPROFILE (with HOMEDRIVE
    // + HOMEPATH as a tertiary fallback). Without this, tests that seed
    // a fake `~/.arkor/credentials.json` under HOME are silently bypassed
    // on Windows — the CLI keeps reading the real runner profile and
    // reports "Not signed in", causing assertions to fail in confusing
    // ways. Tests that genuinely need divergent HOME / USERPROFILE values
    // can still set USERPROFILE explicitly: extraEnv is spread last.
    const homeMirror: NodeJS.ProcessEnv =
      extraEnv.HOME !== undefined ? { USERPROFILE: extraEnv.HOME } : {};
    const start = Date.now();
    const child = spawn(process.execPath, [binPath, ...argv], {
      cwd,
      env: {
        ...cleanEnv,
        CI: "1",
        npm_config_user_agent: "",
        GIT_AUTHOR_NAME: "Arkor E2E",
        GIT_AUTHOR_EMAIL: "e2e@arkor.test",
        GIT_COMMITTER_NAME: "Arkor E2E",
        GIT_COMMITTER_EMAIL: "e2e@arkor.test",
        ...homeMirror,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? -1,
        signal,
        elapsedMs: Date.now() - start,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        dir: cwd,
      }),
    );
  });
}

/**
 * Run `git` against `cwd` and return its stdout. Used by tests that need to
 * verify commit metadata or pre-seed a git repo before running the CLI.
 */
export function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? -1,
        signal,
        elapsedMs: Date.now() - start,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        dir: cwd,
      }),
    );
  });
}
