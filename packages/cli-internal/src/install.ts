import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./package-manager";

// === DIAG eng-625 START — REMOVE BEFORE MERGE =========================
// Per-pm lockfile name. Kept only for the diagnostic snapshot below;
// the production path does not depend on it. Mapping mirrors the e2e
// assertion we're trying to debug: pnpm-lock.yaml is missing on Windows
// after `pnpm install` returns successfully.
const DIAG_LOCKFILES: Record<PackageManager, readonly string[]> = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

function diagWrite(line: string): void {
  process.stderr.write(`[DIAG eng-625] ${line}\n`);
}

function diagSnapshot(label: string, cwd: string, pm: PackageManager): void {
  const candidates = DIAG_LOCKFILES[pm];
  const lockExists = candidates.some((name) => existsSync(join(cwd, name)));
  let entries: string;
  try {
    entries = readdirSync(cwd).sort().join(",");
  } catch (err) {
    entries = `<readdir failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
  diagWrite(
    `${label} t=${Date.now()} pm=${pm} lock=${candidates.join("|")} lockExists=${lockExists} entries=[${entries}]`,
  );
}
// === DIAG eng-625 END =================================================

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
  // === DIAG eng-625 START — REMOVE BEFORE MERGE =======================
  diagWrite(
    `install-begin pm=${packageManager} cwd=${cwd} platform=${process.platform} node=${process.versions.node}`,
  );
  diagWrite(
    `env npm_config_user_agent=${process.env.npm_config_user_agent ?? "<unset>"}`,
  );
  diagWrite(
    `env npm_config_lockfile=${process.env.npm_config_lockfile ?? "<unset>"} npm_config_package_lock=${process.env.npm_config_package_lock ?? "<unset>"}`,
  );
  diagWrite(`env NODE_ENV=${process.env.NODE_ENV ?? "<unset>"}`);
  const whereCmd = process.platform === "win32" ? "where" : "which";
  const whereRes = spawnSync(whereCmd, [packageManager], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  diagWrite(
    `${whereCmd} ${packageManager}=${(whereRes.stdout || whereRes.stderr || "<empty>").trim().replace(/\n/g, "|")}`,
  );
  const verRes = spawnSync(packageManager, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    cwd,
  });
  diagWrite(
    `${packageManager} --version=${(verRes.stdout || verRes.stderr || "<empty>").trim()}`,
  );
  diagSnapshot("pre-install", cwd, packageManager);
  // === DIAG eng-625 END ==============================================

  return new Promise((resolve, reject) => {
    const child = spawn(packageManager, ["install"], {
      cwd,
      stdio: "inherit",
      // `pnpm` / `yarn` / `bun` are `.cmd` shims on Windows — spawn needs a
      // shell to resolve them.
      shell: process.platform === "win32",
      env: {
        ...process.env,
        ADBLOCK: "1",
        NODE_ENV: "development",
        DISABLE_OPENCOLLECTIVE: "1",
      },
    });
    // === DIAG eng-625 START — REMOVE BEFORE MERGE =====================
    child.on("exit", (code, signal) => {
      diagWrite(`child exit code=${code} signal=${signal} t=${Date.now()}`);
      diagSnapshot("on-exit", cwd, packageManager);
    });
    // === DIAG eng-625 END ============================================
    child.on("error", reject);
    child.on("close", (code) => {
      // === DIAG eng-625 START — REMOVE BEFORE MERGE ===================
      diagWrite(`child close code=${code} t=${Date.now()}`);
      diagSnapshot("on-close-immediate", cwd, packageManager);
      // Schedule late snapshots; do NOT await — this must not change
      // production timing. The git-add step in gitInitialCommit will run
      // with whatever is on disk at on-close-immediate. Late snapshots
      // tell us whether the file *eventually* materialises (race) vs.
      // never appears (config / shim issue).
      setTimeout(() => diagSnapshot("on-close+50ms", cwd, packageManager), 50);
      setTimeout(() => diagSnapshot("on-close+200ms", cwd, packageManager), 200);
      setTimeout(() => diagSnapshot("on-close+1s", cwd, packageManager), 1000);
      setTimeout(() => diagSnapshot("on-close+5s", cwd, packageManager), 5000);
      // === DIAG eng-625 END ==========================================
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
