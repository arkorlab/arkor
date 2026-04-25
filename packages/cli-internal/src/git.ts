import { spawn } from "node:child_process";

/**
 * Whether `cwd` is already inside a Git working tree. We check so we don't
 * clobber an existing repo by running `git init` on top of it.
 */
export async function isInGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export interface InitialCommitResult {
  /**
   * `true` when the user's signing config was active but the actual signing
   * step failed (missing key, agent timeout, etc.) — we then retried with
   * `commit.gpgsign=false` and produced an unsigned commit. Callers can use
   * this to surface a one-line notice.
   */
  signingFallback: boolean;
}

/**
 * `git init && git add -A && git commit -m <message>` in `cwd`.
 *
 * Signing policy: respect the user's git config first. If the commit fails
 * specifically because signing failed (broken GPG/SSH setup), retry once with
 * signing disabled so the scaffold finishes; any other failure surfaces.
 */
export async function gitInitialCommit(
  cwd: string,
  message: string,
): Promise<InitialCommitResult> {
  await runGit(cwd, ["init", "-q"]);
  await runGit(cwd, ["add", "-A"]);

  const first = await tryGit(cwd, ["commit", "-q", "-m", message]);
  if (first.code === 0) return { signingFallback: false };

  if (looksLikeSigningFailure(first.stderr)) {
    await runGit(cwd, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ]);
    return { signingFallback: true };
  }

  throw new Error(
    `\`git commit\` exited with code ${first.code}: ${
      first.stderr.trim() || "(no stderr)"
    }`,
  );
}

function looksLikeSigningFailure(stderr: string): boolean {
  // Covers GPG (`gpg failed to sign`, `gpg: signing failed`) and SSH
  // (`error: signing failed: <reason>`) variants.
  return /failed to sign|signing failed|gpg failed/i.test(stderr);
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`\`git ${args.join(" ")}\` exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function tryGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: process.platform === "win32",
    });
    const chunks: Buffer[] = [];
    child.stderr?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}
