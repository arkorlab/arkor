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
 */
export function runCli(
  binPath: string,
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...argv], {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        npm_config_user_agent: "",
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
