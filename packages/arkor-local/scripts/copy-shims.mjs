#!/usr/bin/env node
/**
 * Copy the Python shims into `dist/shims/` so the published tarball carries
 * them next to the bundled JS (the runtime resolves them relative to
 * `import.meta.url`). Kept as Node (not shell) to stay Windows-friendly.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const src = join(pkgRoot, "python");
const dst = join(pkgRoot, "dist/shims");

if (!existsSync(src)) {
  console.error(`[copy-shims] expected ${src} to exist.`);
  process.exit(1);
}

await mkdir(join(pkgRoot, "dist"), { recursive: true });
await rm(dst, { recursive: true, force: true });
await cp(src, dst, {
  recursive: true,
  // Local tooling (py_compile checks, an editor's language server) can drop
  // __pycache__ next to the shims; shipping stale bytecode would shadow the
  // .py sources at run time on version-matched Pythons.
  filter: (source) => !source.includes("__pycache__"),
});
console.log(`Copied ${src} -> ${dst}`);
