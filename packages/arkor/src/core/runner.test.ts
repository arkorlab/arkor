import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrainer } from "./runner";
import type { Trainer } from "./types";

function fakeTrainer(onStart?: () => void, onWait?: () => void): Trainer {
  return {
    name: "n",
    async start() {
      onStart?.();
      return { jobId: "j1" };
    },
    async wait() {
      onWait?.();
      return {
        job: {
          id: "j1",
          orgId: "o",
          projectId: "p",
          name: "n",
          status: "completed",
          config: {
            model: "m",
            datasetSource: { type: "huggingface", name: "x" },
          },
          createdAt: "2026-01-01",
          startedAt: null,
          completedAt: null,
        },
        artifacts: [],
      };
    },
    async cancel() {},
  };
}

let cwd: string;
const ORIG_CWD = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-runner-test-"));
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(cwd, { recursive: true, force: true });
});

describe("runTrainer — entry extraction", () => {
  it("throws when the entry file does not exist", async () => {
    await expect(runTrainer("missing.ts")).rejects.toThrow(
      /Training entry not found/,
    );
  });

  it("runs when the entry default-exports a Trainer", async () => {
    const entry = join(cwd, "entry.mjs");
    const calls: string[] = [];
    // Write an ESM module that default-exports a fake Trainer. Use .mjs so
    // Node's ESM loader picks it up without TS stripping.
    writeFileSync(
      entry,
      `export default {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
        cancel: async () => {},
      };`,
    );
    await runTrainer(entry);
    calls.push("ran"); // reach here only if runTrainer returned
    expect(calls).toEqual(["ran"]);
  });

  it("runs when the entry named-exports `trainer`", async () => {
    const entry = join(cwd, "named-entry.mjs");
    writeFileSync(
      entry,
      `export const trainer = {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
        cancel: async () => {},
      };`,
    );
    await expect(runTrainer(entry)).resolves.toBeUndefined();
  });

  it("runs when the entry named-exports an `arkor` manifest", async () => {
    const entry = join(cwd, "arkor-entry.mjs");
    writeFileSync(
      entry,
      `const trainer = {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
        cancel: async () => {},
      };
      export const arkor = Object.freeze({ _kind: "arkor", trainer });`,
    );
    await expect(runTrainer(entry)).resolves.toBeUndefined();
  });

  it("throws when neither default nor named export is a Trainer", async () => {
    const entry = join(cwd, "bad-entry.mjs");
    writeFileSync(entry, `export default { notATrainer: true };`);
    await expect(runTrainer(entry)).rejects.toThrow(
      /must export `arkor`/,
    );
  });

  it("accepts a fake Trainer via direct invocation (sanity)", async () => {
    const t = fakeTrainer();
    expect(typeof t.start).toBe("function");
    expect(typeof t.wait).toBe("function");
  });
});
