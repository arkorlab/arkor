import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart } from "./start";

let cwd: string;
const ORIG_CWD = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-start-test-"));
  // runTrainer falls back to process.cwd() when given a relative entry; we
  // pass an absolute path through runStart, but the bundle-and-import path
  // still resolves CWD-relative imports. Pin it to the temp dir.
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(cwd, { recursive: true, force: true });
});

const FAKE_MANIFEST = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: "run",
    start: async () => ({ jobId: "j1" }),
    wait: async () => ({
      job: {
        id: "j1",
        orgId: "o",
        projectId: "p",
        name: "run",
        status: "completed",
        config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
        createdAt: "2026-01-01",
      },
      artifacts: [],
    }),
    cancel: async () => {},
  },
});
`;

describe("runStart", () => {
  it("auto-builds when the artifact is missing, then runs the trainer", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);

    try {
      await runStart({ cwd });
    } finally {
      spy.mockRestore();
    }

    // Auto-built the artifact on first run.
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
    // Trainer.start() and .wait() both ran.
    const stdout = writes.join("");
    expect(stdout).toContain("Started job j1");
    expect(stdout).toContain("status=completed");
  });

  it("skips the build step when the artifact already exists and no entry override is given", async () => {
    // Branch coverage for `Boolean(opts.entry) || !existsSync(outFile)` —
    // the path where both halves are false. Pre-build the artifact, then
    // confirm runStart imports it without triggering rolldown again.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    // First call builds normally.
    await runStart({ cwd });
    // Damage the source so a rebuild would crash if it ran. With the
    // skip-build branch, the helper imports the cached artifact and the
    // bad source is never re-bundled.
    writeFileSync(join(cwd, "src/arkor/index.ts"), "syntax error <<<");
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
    try {
      await expect(runStart({ cwd })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("Started job j1");
  });

  it("accepts an absolute outDir without joining it under cwd", async () => {
    // Branch coverage for `isAbsolute(outDirRel) ? outDirRel : resolve(...)`.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    const absOut = join(cwd, "abs-out");
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
    try {
      await runStart({ cwd, outDir: absOut });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(absOut, "index.mjs"))).toBe(true);
  });

  it("falls back to process.cwd() when no cwd is provided", async () => {
    // Branch coverage for the cwd default. process.chdir is already pinned
    // to the test's temp dir in beforeEach, so omitting the option lets
    // the helper read it from there.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
    try {
      await runStart({});
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
  });

  it("rebuilds when an explicit entry is provided", async () => {
    const altEntry = join(cwd, "alt-entry.ts");
    writeFileSync(
      altEntry,
      FAKE_MANIFEST.replace(/jobId: "j1"/, 'jobId: "alt"'),
    );

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
    // Use a dedicated outDir so the in-process module cache doesn't return a
    // stale import (each `arkor start` invocation is a fresh process in real
    // usage, but tests share one Node ESM cache).
    try {
      await runStart({
        cwd,
        entry: "alt-entry.ts",
        outDir: ".arkor/build-alt",
      });
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(join(cwd, ".arkor/build-alt/index.mjs"))).toBe(true);
    // The alt entry's jobId surfaces, proving the rebuild used the override.
    expect(writes.join("")).toContain("Started job alt");
  });
});
