import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
 * Caveat (`cwd` carryover): the retry runs in the same `cwd`. Whatever
 * the first attempt wrote (scaffolded files, `git init`, partial
 * `node_modules/`) carries over into attempt 2. The (c) elapsed-ms gate
 * keeps that risk tightly scoped — `SIGKILL_RETRY_MAX_MS` is held below
 * the time scaffold needs to start writing files, so a qualifying run
 * means the bin almost certainly never reached the filesystem. A blanket
 * reset of `cwd` would clobber legitimately pre-seeded state (e.g. tests
 * that `git init` before calling `runCli`), so we accept the best-effort
 * behaviour rather than introducing a snapshot/restore.
 */
export async function runCli(
  binPath: string,
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  let result = await runCliOnce(binPath, argv, cwd, extraEnv);
  if (
    shouldRetryAfterSigkill(result, process.platform, Boolean(process.env.CI))
  ) {
    result = await runCliOnce(binPath, argv, cwd, extraEnv);
  }
  return result;
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
