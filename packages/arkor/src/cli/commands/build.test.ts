import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
});
