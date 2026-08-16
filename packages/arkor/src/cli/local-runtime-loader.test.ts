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
