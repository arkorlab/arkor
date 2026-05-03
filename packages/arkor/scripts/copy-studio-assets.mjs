#!/usr/bin/env node
/**
 * Copy the Vite-built Studio SPA bundle into arkor's `dist/assets/` so the
 * published tarball serves a self-contained UI. Kept as Node (not shell) to
 * stay Windows-friendly.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const src = join(pkgRoot, "../studio-app/dist");
const dst = join(pkgRoot, "dist/assets");

if (!existsSync(src)) {
  console.error(
    `[copy-studio-assets] expected ${src} to exist: run \`pnpm --filter @arkor/studio-app bundle\` first.`,
  );
  process.exit(1);
}

await mkdir(join(pkgRoot, "dist"), { recursive: true });
await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
console.log(`Copied ${src} -> ${dst}`);
