import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadLocalRuntime,
  LocalRuntimeNotInstalledError,
  LocalRuntimeVersionError,
  SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION,
} from "./local-runtime-loader";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-loader-test-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Install a fake `@arkor/local` into the temp project's node_modules. Each
 * call writes a unique entry filename so Node's ESM module cache (keyed by
 * absolute URL) cannot serve a previous test's module body.
 */
let installCounter = 0;
function installFakeRuntime(moduleBody: string): void {
  installCounter += 1;
  const pkgDir = join(cwd, "node_modules", "@arkor", "local");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  const entry = `./dist/index-${String(installCounter)}.mjs`;
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@arkor/local",
      type: "module",
      exports: {
        ".": { import: entry },
        "./package.json": "./package.json",
      },
    }),
  );
  writeFileSync(join(pkgDir, entry), moduleBody);
}

describe("loadLocalRuntime", () => {
  it("loads a compatible runtime from the project's node_modules", async () => {
    installFakeRuntime(
      `export const LOCAL_RUNTIME_PROTOCOL_VERSION = ${String(
        SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION,
      )};
export function createLocalRuntime() {
  return { marker: "loaded", startServer: async () => ({}) };
}
`,
    );
    const runtime = await loadLocalRuntime(cwd);
    expect((runtime as unknown as { marker: string }).marker).toBe("loaded");
  });

  it("explains how to install when the package is missing", async () => {
    // The resolver is injected because vitest's module runner adds a
    // workspace fallback to Node resolution; plain Node (production)
    // throws MODULE_NOT_FOUND exactly like this stub.
    const promise = loadLocalRuntime(cwd, () => {
      throw Object.assign(new Error("Cannot find module"), {
        code: "MODULE_NOT_FOUND",
      });
    });
    await expect(promise).rejects.toBeInstanceOf(LocalRuntimeNotInstalledError);
    await expect(promise).rejects.toThrow(/pnpm add -D @arkor\/local/);
    // bin.ts matches errors by `.name` (instanceof breaks across the
    // dual-package boundary of a bundled CLI), so the name is contract.
    await expect(promise).rejects.toMatchObject({
      name: "LocalRuntimeNotInstalledError",
    });
  });

  it("does not misreport non-resolution failures as not-installed", async () => {
    // An export map hiding ./package.json (or an unreadable manifest)
    // resolves with a DIFFERENT error code; telling that user to install
    // the package they already have would be the wrong remediation.
    const promise = loadLocalRuntime(cwd, () => {
      throw Object.assign(new Error("no exported subpath"), {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      });
    });
    await expect(promise).rejects.toThrow(/installation looks corrupt/);
    await expect(promise).rejects.not.toBeInstanceOf(
      LocalRuntimeNotInstalledError,
    );
  });

  it("treats a manifest without an ESM entry as a corrupt install", async () => {
    installFakeRuntime("export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;\n");
    const pkgDir = join(cwd, "node_modules", "@arkor", "local");
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@arkor/local",
        type: "module",
        exports: { "./package.json": "./package.json" },
      }),
    );
    await expect(loadLocalRuntime(cwd)).rejects.toThrow(
      /no ESM entry in its export map/,
    );
  });

  it("reports an unparsable package.json instead of crashing raw", async () => {
    // Resolution itself would choke on broken JSON before our read, so the
    // manifest path is injected to reach the parse guard directly (matching
    // a corruption that appears after resolution, e.g. a truncated write).
    const pkgDir = join(cwd, "node_modules", "@arkor", "local");
    mkdirSync(pkgDir, { recursive: true });
    const manifestPath = join(pkgDir, "package.json");
    writeFileSync(manifestPath, "{ not json");
    await expect(loadLocalRuntime(cwd, () => manifestPath)).rejects.toThrow(
      /installation looks corrupt/,
    );
  });

  it("asks the user to upgrade arkor when the runtime is newer", async () => {
    installFakeRuntime(
      `export const LOCAL_RUNTIME_PROTOCOL_VERSION = ${String(
        SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION + 1,
      )};
export function createLocalRuntime() { return {}; }
`,
    );
    const promise = loadLocalRuntime(cwd);
    await expect(promise).rejects.toBeInstanceOf(LocalRuntimeVersionError);
    await expect(promise).rejects.toThrow(/Upgrade arkor/);
    await expect(promise).rejects.toMatchObject({
      name: "LocalRuntimeVersionError",
    });
  });

  it("asks the user to upgrade @arkor/local when the runtime is older", async () => {
    installFakeRuntime(
      `export const LOCAL_RUNTIME_PROTOCOL_VERSION = 0;
export function createLocalRuntime() { return {}; }
`,
    );
    const promise = loadLocalRuntime(cwd);
    await expect(promise).rejects.toBeInstanceOf(LocalRuntimeVersionError);
    await expect(promise).rejects.toThrow(/Upgrade @arkor\/local/);
  });

  it("treats a missing createLocalRuntime export as a corrupt install", async () => {
    installFakeRuntime(
      `export const LOCAL_RUNTIME_PROTOCOL_VERSION = ${String(
        SUPPORTED_LOCAL_RUNTIME_PROTOCOL_VERSION,
      )};
`,
    );
    await expect(loadLocalRuntime(cwd)).rejects.toThrow(
      /does not export createLocalRuntime/,
    );
  });
});
