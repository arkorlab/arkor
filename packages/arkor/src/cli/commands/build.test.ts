import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "./build";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-build-test-"));
});

afterEach(() => {
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

describe("runBuild", () => {
  it("bundles src/arkor/index.ts to .arkor/build/index.mjs", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const result = await runBuild({ cwd, quiet: true });

    expect(result.outFile).toBe(join(cwd, ".arkor/build/index.mjs"));
    expect(existsSync(result.outFile)).toBe(true);
    const content = readFileSync(result.outFile, "utf8");
    // Manifest brand survives bundling.
    expect(content).toContain("_kind");
    expect(content).toContain('"arkor"');
  });

  it("throws when the entry does not exist", async () => {
    await expect(runBuild({ cwd, quiet: true })).rejects.toThrow(
      /Build entry not found/,
    );
  });

  it("accepts a custom entry argument", async () => {
    const customEntry = join(cwd, "custom-entry.ts");
    writeFileSync(customEntry, FAKE_MANIFEST);

    const result = await runBuild({
      cwd,
      entry: "custom-entry.ts",
      quiet: true,
    });

    expect(result.entry).toBe(customEntry);
    expect(existsSync(result.outFile)).toBe(true);
  });

  it("accepts an absolute entry path and an absolute outDir", async () => {
    // Branch coverage for the `isAbsolute(...) ? ... : resolve(cwd, ...)`
    // checks on both `entry` and `outDir`. With absolute paths the helper
    // skips the resolve() join, so passing one outside cwd must round-trip.
    const customEntry = join(cwd, "abs-entry.ts");
    writeFileSync(customEntry, FAKE_MANIFEST);
    const absOut = join(cwd, "abs-out");
    const result = await runBuild({
      cwd,
      entry: customEntry,
      outDir: absOut,
      quiet: true,
    });
    expect(result.entry).toBe(customEntry);
    expect(result.outFile).toBe(join(absOut, "index.mjs"));
    expect(existsSync(result.outFile)).toBe(true);
  });

  it("falls back to process.cwd() when no cwd is provided", async () => {
    // Branch coverage for `opts.cwd ?? process.cwd()`. Chdir into a fresh
    // temp dir so the build doesn't pollute the test runner's cwd.
    const ORIG = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "arkor-build-cwd-"));
    // macOS resolves `/tmp/...` to `/private/tmp/...` via realpath; the
    // helper's `process.cwd()` then returns the canonicalised form, which
    // doesn't string-match the raw `mkdtemp` result. Resolve both sides
    // through realpath so the comparison stays portable.
    const realDir = realpathSync(dir);
    process.chdir(realDir);
    try {
      mkdirSync(join(realDir, "src/arkor"), { recursive: true });
      writeFileSync(join(realDir, "src/arkor/index.ts"), FAKE_MANIFEST);
      const result = await runBuild({ quiet: true });
      expect(result.outFile).toBe(join(realDir, ".arkor/build/index.mjs"));
    } finally {
      process.chdir(ORIG);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs a success line when quiet is not set (default)", async () => {
    // The `quiet` default is false, so the helper writes through ui.log.
    // Capture stdout to verify the log lands without snooping into clack.
    // Use vi.spyOn so the original method reference is preserved
    // (assigning `process.stdout.write.bind(...)` and restoring would
    // permanently rebind the slot to a wrapper for the rest of the
    // worker, breaking later tests that spy on the same slot).
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    const chunks: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: unknown) => {
        chunks.push(String(c));
        return true;
      }) as typeof process.stdout.write);
    try {
      await runBuild({ cwd });
    } finally {
      writeSpy.mockRestore();
    }
    const out = chunks.join("");
    // clack's success log uses a checkmark glyph; assert on the path arrow
    // we know runBuild prints. Match either separator so the assertion
    // doesn't break on Windows where node:path emits `\`.
    expect(out).toMatch(/src[\\/]arkor[\\/]index\.ts/);
    expect(out).toMatch(/index\.mjs/);
  });
});
