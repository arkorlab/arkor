import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  dir: string;
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
 */
export function runCli(
  binPath: string,
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
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
    // Per-spawn yarn cache. Vitest runs test files in parallel workers;
    // when two workers each call `arkor init --use-yarn`, both yarn 1
    // processes hammer the shared `~/.cache/yarn/v6/` and race during
    // tarball extraction — the inner mkdir-then-write sequence collides
    // and the second loser dies with `ENOENT: ... open
    // '...integrity/node_modules/<pkg>/.yarn-tarball.tgz'`. yarn 1's
    // `--mutex network` would also work, but it's a flag (we'd need
    // pm-aware install args in the SDK); a per-spawn `YARN_CACHE_FOLDER`
    // sidesteps the issue at the env layer for free, and yarn-berry /
    // npm / pnpm / bun all ignore the variable.
    const yarnCacheDir = mkdtempSync(join(tmpdir(), "arkor-e2e-yarn-cache-"));
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
        YARN_CACHE_FOLDER: yarnCacheDir,
        // yarn 4 detects `CI=1` (which we force above) and turns on
        // `enableImmutableInstalls` by default — that refuses to write
        // the lockfile a freshly scaffolded project doesn't have yet
        // and exits with `YN0028: The lockfile would have been created
        // by this install, which is explicitly forbidden`. Set the
        // override here so the install-matrix yarn-berry case works
        // both in CI (where this used to live in ci.yaml) and via a
        // local `ARKOR_E2E_PM=yarn-berry pnpm --filter @arkor/e2e-cli
        // test` run, which previously needed the env var threaded
        // through manually. yarn 1 / npm / pnpm / bun all ignore it.
        YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
        // yarn 1 has a long-standing race extracting esbuild-style
        // platform-specific optionalDependencies inside a single
        // process — the parent `node_modules/@<scope>/<arch>/` dir
        // gets created racily and the tarball write fails with ENOENT.
        // The per-spawn YARN_CACHE_FOLDER above already prevents
        // *inter*-process races (different test workers don't share a
        // cache); this serialises *intra*-process resolution as a
        // belt-and-braces measure. yarn-berry reads
        // `networkConcurrency` from `.yarnrc.yml` instead, so the env
        // is a no-op for it.
        YARN_NETWORK_CONCURRENCY: "1",
        ...homeMirror,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const cleanup = () => {
      // Per-spawn yarn cache is single-use; remove it on either close
      // or error so we don't leak `arkor-e2e-yarn-cache-*` dirs into
      // tmpdir on long CI runs.
      rmSync(yarnCacheDir, { recursive: true, force: true });
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        dir: cwd,
      });
    });
  });
}

/**
 * Run `git` against `cwd` and return its stdout. Used by tests that need to
 * verify commit metadata or pre-seed a git repo before running the CLI.
 */
export function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        dir: cwd,
      }),
    );
  });
}
