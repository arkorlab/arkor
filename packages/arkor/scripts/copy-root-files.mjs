#!/usr/bin/env node
/**
 * Copy single-source root files (currently `CONTRIBUTING.md`) into the
 * package directory so they end up in the published tarball. Kept as Node
 * (not shell) to stay Windows-friendly.
 */
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const repoRoot = join(pkgRoot, "../..");

const FILES = ["CONTRIBUTING.md"];

for (const name of FILES) {
  const src = join(repoRoot, name);
  const dst = join(pkgRoot, name);
  if (!existsSync(src)) {
    console.error(`[copy-root-files] missing ${src}`);
    process.exit(1);
  }
  await copyFile(src, dst);
  console.log(`Copied ${src} -> ${dst}`);
}
