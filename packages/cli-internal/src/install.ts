import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./package-manager";

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
  // Override only when there's no pre-existing `yarn.lock` in `cwd`
  // — i.e. the fresh-scaffold case. With a lockfile already present
  // (an existing yarn-berry project that `arkor init` was merged
  // into), we MUST NOT bypass yarn's immutability check: doing so
  // would silently let install rewrite the user's committed
  // lockfile, which the safety check exists to prevent in CI.
  // (PR #99 round 13 introduced the unconditional override; round
  // 17 narrowed it to fresh scaffolds after Copilot flagged the
  // lockfile-rewrite hazard.) yarn 1 / npm / pnpm / bun all ignore
  // the variable, so the gate is a no-op outside yarn-berry.
  if (
    packageManager === "yarn" &&
    !existsSync(join(cwd, "yarn.lock"))
  ) {
    env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
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
