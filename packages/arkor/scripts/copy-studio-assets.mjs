#!/usr/bin/env node
/**
 * Copy the Vite-built Studio SPA bundle into arkor's `dist/assets/` so the
 * published tarball serves a self-contained UI. Kept as Node (not shell) to
 * stay Windows-friendly.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const src = join(pkgRoot, "../studio-app/dist");
const dst = join(pkgRoot, "dist/assets");

// Through `pnpm build` (turbo) the workspace dep on `@arkor/studio-app`
// guarantees the dist is already there via `^build`. Direct invocations
// (`pnpm --filter arkor build`, `e2e/cli`'s `pretest`, fresh clones) skip
// turbo's orchestration, so fall back to building the SPA on demand here.
if (!existsSync(src)) {
  console.log(
    `[copy-studio-assets] ${src} missing — building @arkor/studio-app first.`,
  );
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@arkor/studio-app", "build"],
    { stdio: "inherit", cwd: pkgRoot },
  );
  if (result.status !== 0) {
    console.error(
      `[copy-studio-assets] failed to build @arkor/studio-app (exit ${result.status}).`,
    );
    process.exit(result.status ?? 1);
  }
  if (!existsSync(src)) {
    console.error(
      `[copy-studio-assets] ${src} still missing after build — aborting.`,
    );
    process.exit(1);
  }
}

await mkdir(join(pkgRoot, "dist"), { recursive: true });
await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
console.log(`Copied ${src} -> ${dst}`);
