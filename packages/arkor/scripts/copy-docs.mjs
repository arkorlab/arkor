#!/usr/bin/env node
/**
 * Copy the repo-root `docs/` source tree into the package directory so the
 * Mintlify-authored docs ship inside the published `arkor` tarball
 * alongside the SDK + CLI. The Mintlify config (`docs.json`), the docs
 * workspace's own `package.json`, and `node_modules` are excluded —
 * consumers should read the published site at https://docs.arkor.ai or
 * the markdown files directly, not run Mintlify locally from an installed
 * tarball.
 *
 * Kept as Node (not shell) to stay Windows-friendly.
 */
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const src = join(pkgRoot, "../../docs");
const dst = join(pkgRoot, "docs");

const EXCLUDE_NAMES = new Set(["docs.json", "package.json", "node_modules"]);

if (!existsSync(src)) {
  console.error(`[copy-docs] expected ${src} to exist`);
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await cp(src, dst, {
  recursive: true,
  filter: (source) => {
    const rel = relative(src, source);
    if (rel === "") return true;
    const top = rel.split(sep)[0];
    return !EXCLUDE_NAMES.has(top);
  },
});
console.log(`Copied ${src} -> ${dst} (excluded: ${[...EXCLUDE_NAMES].join(", ")})`);
