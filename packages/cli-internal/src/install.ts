import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PackageManager } from "./package-manager";

/**
 * Walk from `cwd` up to filesystem root looking for the first
 * `yarn.lock`. Mirrors yarn's own resolution: in a yarn-berry
 * workspace, `yarn install` from a subdirectory writes to the
 * ENCLOSING workspace's lockfile, so the immutable-install check
 * has to look at the ancestor tree, not just `cwd`.
 *
 * Walks until `dirname()` returns the same path it was given —
 * the canonical "reached filesystem root" signal. The earlier
 * 20-iteration cap (round 27 defensive symlink guard) was
 * misclassifying real deeply-nested workspace paths as having
 * no enclosing lockfile, then setting
 * `YARN_ENABLE_IMMUTABLE_INSTALLS=false` and bypassing yarn-
 * berry's CI immutability guard — exactly the rewrite hazard
 * the round-27 walk was supposed to prevent (PR #99 round 39
 * Codex P2). `dirname` is purely syntactic (doesn't follow
 * symlinks) so it terminates at the root naturally.
 *
 * (PR #99 round 27 — Copilot flagged the cwd-only check as
 * unsafe in the workspace-subdir case: a user scaffolding into
 * `monorepo/packages/foo` would otherwise have the override
 * fire, letting yarn rewrite the root `monorepo/yarn.lock`
 * silently in CI.)
 */
function hasEnclosingYarnLock(cwd: string): boolean {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "yarn.lock"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false; // reached filesystem root
    dir = parent;
  }
}

/**
 * Run `install` through the given package manager in `cwd` with stdio
 * inherited. Patterned after create-next-app's helper: `ADBLOCK` /
 * `DISABLE_OPENCOLLECTIVE` suppress promotional output, and
 * `NODE_ENV=development` keeps pnpm from skipping devDependencies
 * (pnpm treats `production` as "no dev deps").
 */
export async function install(
  packageManager: PackageManager,
  cwd: string,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADBLOCK: "1",
    NODE_ENV: "development",
    DISABLE_OPENCOLLECTIVE: "1",
  };
  // yarn 4 (berry) flips `enableImmutableInstalls` to `true` by
  // default whenever it sees `CI=1`. The very first install of a
  // freshly scaffolded project has no `yarn.lock`, so an immutable
  // install refuses to write one and exits with `YN0028: The
  // lockfile would have been created by this install, which is
  // explicitly forbidden`. Real users running `arkor init
  // --use-yarn` / `create-arkor --use-yarn` in their CI hit this.
  //
  // Override only when there's no enclosing `yarn.lock` in the
  // ancestor tree — i.e. the fresh-scaffold case. With a lockfile
  // already present (in cwd OR in any ancestor — yarn-berry
  // workspace subdirs share the root's lockfile), we MUST NOT
  // bypass yarn's immutability check: doing so would silently let
  // install rewrite the committed lockfile, which the safety
  // check exists to prevent in CI.
  //
  // History:
  //   - Round 13: introduced the unconditional override.
  //   - Round 17: narrowed to fresh scaffolds via cwd-only
  //     `existsSync(yarn.lock)` after Copilot flagged the
  //     lockfile-rewrite hazard.
  //   - Round 27: extended the check to walk up the ancestor
  //     tree after Copilot pointed out workspace-subdir scaffolds
  //     bypassed the round-17 guard (cwd has no lockfile, but the
  //     enclosing workspace does).
  //
  // yarn 1 / npm / pnpm / bun all ignore the variable, so the
  // gate is a no-op outside yarn-berry.
  //
  // Round 32 (Copilot, PR #99): when there IS an enclosing
  // `yarn.lock` we MUST clear any inherited
  // `YARN_ENABLE_IMMUTABLE_INSTALLS=false` from the parent
  // shell. Without the explicit delete, a CI that exports the
  // var globally (or a developer who set it for some other
  // workflow) would leak it through `{ ...process.env, ... }`
  // and bypass the very immutability check the lockfile-present
  // branch is supposed to preserve. Keep the override only on
  // the fresh-scaffold branch where bypassing is intentional.
  //
  // Round 39 (Codex P2, PR #99): on Windows env-var lookup is
  // case-insensitive (`PATH` == `Path` == `path`), and Node
  // passes through whatever casing the parent shell used. A
  // `yarn_enable_immutable_installs=false` (or any other
  // casing) inherited from the parent would otherwise survive
  // a case-exact `delete env.YARN_ENABLE_IMMUTABLE_INSTALLS`
  // and yarn-berry on Windows would still honour it. Strip
  // every case-insensitive match before deciding whether to
  // re-set the canonical form. POSIX env vars are case-
  // sensitive so the loop is a no-op outside Windows in
  // practice, but the pattern is portable.
  if (packageManager === "yarn") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "YARN_ENABLE_IMMUTABLE_INSTALLS") {
        delete env[key];
      }
    }
    if (!hasEnclosingYarnLock(cwd)) {
      env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
    }
    // else: keep it deleted — yarn-berry's default `CI=1` behaviour
    // is to refuse a lockfile-rewriting install, exactly the safety
    // we want with an enclosing lockfile.
  }
  return new Promise((resolve, reject) => {
    const child = spawn(packageManager, ["install"], {
      cwd,
      stdio: "inherit",
      // `pnpm` / `yarn` / `bun` are `.cmd` shims on Windows — spawn needs a
      // shell to resolve them.
      shell: process.platform === "win32",
      env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`\`${packageManager} install\` exited with code ${code}`),
        );
        return;
      }
      resolve();
    });
  });
}
