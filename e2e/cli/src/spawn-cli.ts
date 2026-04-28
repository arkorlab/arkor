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
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("npm_config_") || key.startsWith("pnpm_config_")) {
      continue;
    }
    cleanEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
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
        ...extraEnv,
      },
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
