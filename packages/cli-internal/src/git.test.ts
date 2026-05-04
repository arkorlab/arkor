import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitInitialCommit, isInGitRepo } from "./git";

let cwd: string;

function runGit(args: string[], opts: { cwd: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Without an `error` listener, a spawn failure (git missing, EACCES,
    // ENOENT on a stale cwd) leaves the promise pending forever, so the
    // test run hangs until vitest's per-test timeout — diagnose it as a
    // fast deterministic failure instead.
    child.on("error", (err) =>
      reject(new Error(`spawn git ${args.join(" ")} failed: ${err.message}`)),
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-internal-git-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("isInGitRepo", () => {
  it("returns false in a directory that is not a git working tree", async () => {
    expect(await isInGitRepo(cwd)).toBe(false);
  });

  it("returns true once `git init` has run", async () => {
    await runGit(["init", "-q"], { cwd });
    expect(await isInGitRepo(cwd)).toBe(true);
  });

  it("returns false when the cwd does not exist", async () => {
    // Spawning `git rev-parse` in a non-existent directory triggers the
    // `error` event on the child process; the helper must swallow it as
    // "not a repo" rather than rejecting.
    expect(await isInGitRepo(join(cwd, "does-not-exist"))).toBe(false);
  });
});

describe("gitInitialCommit", () => {
  // Provide deterministic identity + disable signing globally for the test
  // process; gitInitialCommit otherwise inherits the developer's git config
  // which may or may not be configured to sign.
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env.GIT_AUTHOR_NAME = "Test";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "Test";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";
    // `commit.gpgsign` defaults to false, but a developer with a global
    // `commit.gpgsign=true` would otherwise leak in via inheritance.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "false";
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIG_ENV);
  });

  it(
    "creates a commit with the given message and reports no signing fallback",
    async () => {
      writeFileSync(join(cwd, "README.md"), "# hello\n");
      const result = await gitInitialCommit(cwd, "Initial commit from test");
      expect(result.signingFallback).toBe(false);

      const subject = (
        await runGit(["log", "-1", "--pretty=%s"], { cwd })
      ).trim();
      expect(subject).toBe("Initial commit from test");

      // The README was staged via `git add -A`.
      const tracked = (
        await runGit(["ls-files"], { cwd })
      ).trim().split("\n");
      expect(tracked).toContain("README.md");
    },
    // Vitest's 5s default is too tight for GitHub Windows runners — git
    // init+add+commit through three spawn() calls intermittently lands
    // past 5s under Defender / file-locking pressure, even though sibling
    // tests in this file pass in <1s. Not a real regression.
    30_000,
  );

  it("preserves an exotic message containing quotes and newlines", async () => {
    writeFileSync(join(cwd, "f.txt"), "x");
    // Single-quote inside a message used to break naive shell-quoted
    // implementations; spawn() avoids the shell so this should pass through.
    const message = "Initial commit from `arkor init`";
    await gitInitialCommit(cwd, message);
    const subject = (
      await runGit(["log", "-1", "--pretty=%s"], { cwd })
    ).trim();
    expect(subject).toBe(message);
  });

  it("falls back to commit.gpgsign=false when signing is forced and broken", async () => {
    writeFileSync(join(cwd, "f.txt"), "x");
    // Force gpg signing with a non-existent program so the signing step
    // fails with a recognisable "gpg failed to sign" stderr — exactly the
    // shape the helper retries past.
    process.env.GIT_CONFIG_COUNT = "3";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    process.env.GIT_CONFIG_KEY_1 = "gpg.program";
    process.env.GIT_CONFIG_VALUE_1 = "/nonexistent/gpg-binary";
    process.env.GIT_CONFIG_KEY_2 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_2 = "true";

    const result = await gitInitialCommit(cwd, "Initial commit from test");
    expect(result.signingFallback).toBe(true);

    // Commit landed despite the broken signing config.
    const subject = (
      await runGit(["log", "-1", "--pretty=%s"], { cwd })
    ).trim();
    expect(subject).toBe("Initial commit from test");
  });

  it("rejects when commit fails for a non-signing reason", async () => {
    // Empty repo with nothing staged → `git commit` errors "nothing to
    // commit" rather than a signing failure; the helper must surface it.
    await expect(
      gitInitialCommit(cwd, "should fail"),
    ).rejects.toThrow(/git commit.*exited/);
  });

  it("propagates the failing exit code when `git init` itself fails", async () => {
    // A regular file at <cwd>/.git is valid in submodule form (a "gitfile"
    // pointing at the real gitdir). Pointing it at garbage makes the
    // gitfile parser reject with exit 128, which exercises the runGit
    // close-with-non-zero branch. Without this assertion, runGit's
    // `if (code !== 0) reject(...)` would never be exercised by the
    // gitInitialCommit happy path.
    writeFileSync(join(cwd, ".git"), "this is not a valid gitfile");
    await expect(
      gitInitialCommit(cwd, "anything"),
    ).rejects.toThrow(/git init.*exited with code/);
  });

  it("rejects with the spawn error when git is not on PATH at all", async () => {
    // Drop `git` off PATH so spawn can't resolve it; the EventEmitter's
    // `error` event fires (vs. the `close` event after a non-zero exit).
    const ORIG_PATH = process.env.PATH;
    process.env.PATH = "/nonexistent-path-with-no-git";
    try {
      await expect(gitInitialCommit(cwd, "x")).rejects.toThrow();
    } finally {
      // Node coerces `process.env.X = undefined` to the literal string
      // "undefined", which would then leak into later tests' spawn
      // resolution. Delete-on-undefined matches the pattern used in the
      // `cli-internal/src/install.test.ts` afterEach.
      if (ORIG_PATH === undefined) delete process.env.PATH;
      else process.env.PATH = ORIG_PATH;
    }
  });
});
