import { spawn, type ChildProcess } from "node:child_process";

/**
 * Detect the major version of the `yarn` binary on PATH (resolved
 * relative to `cwd` so corepack's `packageManager:`-aware
 * resolution wins for a workspace-pinned yarn).
 *
 * Used by `scaffold()` as the last-resort signal in the
 * `--use-yarn + existing-project + no other yarn-berry signal`
 * case (PR #99 round 30 review). Without runtime detection the
 * gate has to guess between yarn 1 (would install fine without
 * `.yarnrc.yml`) and yarn 4 fresh bootstrap (would PnP-fail and
 * silently break `arkor dev`). Rounds 20 / 27 / 29 ping-ponged
 * between the two trade-offs; runtime detection resolves it.
 *
 * Returns:
 *   - the major version number when `yarn --version` produces a
 *     semver-shaped output (`1.22.22` → 1, `4.6.0` → 4)
 *   - `undefined` for any reason it can't be resolved (yarn not
 *     on PATH, exec error, malformed output, timeout)
 *
 * Conservative on errors so the caller's "no positive signal →
 * no caveat" default keeps yarn 1 users sailing through when
 * detection fails (the yarn-1 path doesn't need the caveat).
 *
 * Lives in its own module so `scaffold.test.ts` can `vi.mock`
 * the binding without fanning a child-process mock into every
 * scaffold test (only the no-signal branch needs it).
 */
export async function detectYarnMajor(
  cwd: string,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: number | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn("yarn", ["--version"], {
        cwd,
        // `yarn` is a `.cmd` shim on Windows — same `shell: true`
        // policy as `cli-internal/install.ts`'s `spawn` call.
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Synchronous spawn failure (rare; some Node platforms
      // raise instead of emitting `error`). Treat as "yarn not
      // available".
      settle(undefined);
      return;
    }
    // Hard timeout against a yarn that hangs on stdin or version
    // probe (defensive — not observed in practice but cheap).
    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      settle(undefined);
    }, 5000);
    timeoutId.unref?.();
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timeoutId);
      settle(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        settle(undefined);
        return;
      }
      const match = /^(\d+)\./.exec(output.trim());
      if (!match) {
        settle(undefined);
        return;
      }
      const major = Number.parseInt(match[1] ?? "", 10);
      settle(Number.isFinite(major) ? major : undefined);
    });
  });
}
