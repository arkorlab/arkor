import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARKOR_BIN } from "./bins";
import { cleanup, findBunBin, makeTempDir, runCli } from "./spawn-cli";

// Bun is a JavaScript runtime built on JavaScriptCore (not V8 / Node),
// so it doesn't ship the same set of built-ins, polyfills, or default
// flags as Node. The existing matrix exercises Bun only as a
// PACKAGE MANAGER (`--use-bun` flag, where Node is still the process
// that actually runs arkor's bundled `dist/bin.mjs`). That covers
// `bun install`'s lockfile + scaffolder integration but leaves the
// runtime-compat axis untested: a Node-only API leaking into the SDK
// or CLI bundle (e.g. an inadvertent `process.binding`, a
// `node:async_hooks` import that Bun stubs differently, a
// `URLPattern`-style global mismatch) would slip through.
//
// These tests run the same `arkor` CLI bundle under `bun` (the
// runtime) instead of `node` and assert it produces the same
// observable output. They auto-skip when `bun` isn't on PATH so
// local developers without bun installed don't see spurious
// failures; CI provisions bun for the dedicated bun-runtime job.
const BUN_BIN = findBunBin();

describe.skipIf(BUN_BIN === undefined)("arkor CLI under the Bun runtime", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir("arkor-bun-runtime-e2e-");
  });

  afterEach(() => {
    cleanup(cwd);
  });

  it("scaffolds a project via `arkor init -y --skip-install --skip-git`", async () => {
    // Reuses the canonical "arkor init scaffolds files" assertion
    // from `arkor-init.test.ts`, but spawned with bun as the
    // runtime. If bun stubs a node API the CLI quietly depends on,
    // the spawned process would crash here (`result.code !== 0`) or
    // the scaffolded files would be missing on disk.
    const result = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git"],
      cwd,
      {},
      "bun",
    );
    if (result.code !== 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[bun-runtime] arkor init exited non-zero:\n` +
          `  --- stdout ---\n${result.stdout}\n` +
          `  --- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "src/arkor/index.ts"))).toBe(true);
    expect(existsSync(join(cwd, "src/arkor/trainer.ts"))).toBe(true);
    expect(existsSync(join(cwd, "arkor.config.ts"))).toBe(true);
    expect(existsSync(join(cwd, "package.json"))).toBe(true);
  });

  it("builds a self-contained manifest via `arkor build`", async () => {
    // Mirror of `arkor-build.test.ts`'s happy path, but the bundling
    // pipeline itself (esbuild via tsdown) runs under bun. The
    // bundler is a long path through node-built-ins (`node:fs`,
    // `node:path`, `node:worker_threads` for esbuild workers), so
    // bun-runtime bugs in any of those would show up as a build
    // failure or a malformed output here.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    const fakeManifest = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: "smoke",
    start: async () => ({ jobId: "j" }),
    wait: async () => ({ job: {}, artifacts: [] }),
    cancel: async () => {},
  },
});
`;
    writeFileSync(join(cwd, "src/arkor/index.ts"), fakeManifest);

    const result = await runCli(ARKOR_BIN, ["build"], cwd, {}, "bun");
    if (result.code !== 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[bun-runtime] arkor build exited non-zero:\n` +
          `  --- stdout ---\n${result.stdout}\n` +
          `  --- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.code).toBe(0);

    const outFile = join(cwd, ".arkor/build/index.mjs");
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf8");
    // The manifest brand and trainer name should survive bundling
    // regardless of which runtime drove esbuild.
    expect(content).toContain("_kind");
    expect(content).toContain('"arkor"');
    expect(content).toContain('"smoke"');
  });
});
