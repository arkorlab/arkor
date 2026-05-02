import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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
    async requestEarlyStop() {},
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

  it("throws when the module has no default export at all (skips the nested-trainer probe)", async () => {
    // Without the falsy short-circuit on `mod.default`, the helper would
    // attempt `(undefined as Record).trainer` and crash with a
    // TypeError instead of the actionable "must export …" message.
    const entry = join(cwd, "no-default.mjs");
    writeFileSync(entry, `export const random = "value";`);
    await expect(runTrainer(entry)).rejects.toThrow(
      /must export `arkor`/,
    );
  });

  it("throws when default export is a primitive (typeof !== 'object' branch)", async () => {
    // The second half of `mod.default && typeof mod.default === "object"` —
    // a primitive default like `42` or `"foo"` must short-circuit out of
    // the nested-trainer probe.
    const entry = join(cwd, "primitive-default.mjs");
    writeFileSync(entry, `export default 42;`);
    await expect(runTrainer(entry)).rejects.toThrow(
      /must export `arkor`/,
    );
  });

  it("accepts a default export wrapping a `trainer` field (legacy power-user shape)", async () => {
    // Hits the `if (isTrainer(nested)) return nested` branch — the only
    // place line 38 is reachable.
    const entry = join(cwd, "default-with-trainer.mjs");
    writeFileSync(
      entry,
      `export default {
        trainer: {
          name: "n",
          start: async () => ({ jobId: "j1" }),
          wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
          cancel: async () => {},
        },
      };`,
    );
    await expect(runTrainer(entry)).resolves.toBeUndefined();
  });

  it("falls back to DEFAULT_ENTRY (src/arkor/index.ts) when called with no argument", async () => {
    // Branch coverage for `file ?? DEFAULT_ENTRY`. Place the entry at
    // `<cwd>/src/arkor/index.ts` and invoke runTrainer() — the default
    // path is what `arkor start` and Studio's "Run training" button use.
    const arkorDir = join(cwd, "src", "arkor");
    mkdirSync(arkorDir, { recursive: true });
    writeFileSync(
      join(arkorDir, "index.mjs"),
      `export const trainer = {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
        cancel: async () => {},
      };`,
    );
    // The runner uses `src/arkor/index.ts`, but Node's loader resolves
    // index.mjs in tests where TS isn't stripped. Emulate by writing a
    // re-export at the .ts path that points at the .mjs sibling.
    writeFileSync(
      join(arkorDir, "index.ts"),
      `export * from "./index.mjs";\n`,
    );
    // Pass undefined explicitly to exercise the `?? DEFAULT_ENTRY` branch
    // — Node's experimental-strip-types handles the .ts extension at
    // runtime. (vitest also strips TS so this works under test too.)
    await expect(runTrainer()).resolves.toBeUndefined();
  });

  it("resolves a relative path against process.cwd()", async () => {
    // `runTrainer(undefined)` falls back to the DEFAULT_ENTRY constant
    // ("src/arkor/index.ts"), which is then resolved against cwd. We
    // exercise the relative-resolve branch by writing the entry into the
    // expected location.
    const arkorDir = join(cwd, "src", "arkor");
    mkdirSync(arkorDir, { recursive: true });
    writeFileSync(
      join(arkorDir, "index.mjs"),
      `export const trainer = {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: { id: "j1", orgId: "o", projectId: "p", name: "n", status: "completed", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, createdAt: "2026-01-01", startedAt: null, completedAt: null }, artifacts: [] }),
        cancel: async () => {},
      };`,
    );
    // Pass a relative path; runTrainer should resolve against process.cwd
    // (which beforeEach set to the temp dir).
    await expect(runTrainer("src/arkor/index.mjs")).resolves.toBeUndefined();
  });

  it("accepts a fake Trainer via direct invocation (sanity)", async () => {
    const t = fakeTrainer();
    expect(typeof t.start).toBe("function");
    expect(typeof t.wait).toBe("function");
  });
});

describe("runTrainer — shutdown signal handling", () => {
  it("first SIGTERM calls trainer.requestEarlyStop and exits 0; second SIGTERM exits 143", async () => {
    // Fake trainer whose `wait()` hangs until the test manually resolves it
    // (via a global helper). This lets us hold the run in flight long
    // enough to assert both signal-handling branches without racing the
    // `finally` block that removes the listeners.
    const trainerSrc = `
      let earlyStopCalls = 0;
      let resolveWait;
      const waitPromise = new Promise((r) => { resolveWait = r; });
      globalThis.__test_signalProbe = {
        get earlyStopCalls() { return earlyStopCalls; },
        finishWait: () => resolveWait({
          job: {
            id: "j1", orgId: "o", projectId: "p", name: "n",
            status: "completed",
            config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
            createdAt: "2026",
          },
          artifacts: [],
        }),
      };
      export const trainer = {
        name: "n",
        start: async () => ({ jobId: "j1" }),
        wait: () => waitPromise,
        cancel: async () => {},
        requestEarlyStop: async () => { earlyStopCalls++; },
      };
    `;
    const entry = join(cwd, "src/arkor/index.mjs");
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(entry, trainerSrc);

    const exitCalls: number[] = [];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const runPromise = runTrainer("src/arkor/index.mjs");
      // Wait for import + start() to settle so the handler is registered
      // before we synthesise SIGTERM. The fake's `wait()` hangs forever, so
      // the run remains in flight throughout the assertions.
      await new Promise((r) => setTimeout(r, 25));

      const probe = (globalThis as unknown as {
        __test_signalProbe: {
          earlyStopCalls: number;
          finishWait: () => void;
        };
      }).__test_signalProbe;

      // 1st SIGTERM → requestEarlyStop is called, exit(0) scheduled in the
      // promise's `.finally`.
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setTimeout(r, 25));
      expect(probe.earlyStopCalls).toBe(1);
      expect(exitCalls).toContain(0);

      // 2nd SIGTERM (still in-flight, listeners not yet removed) →
      // exit(143) immediately, no second requestEarlyStop call.
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setTimeout(r, 25));
      expect(probe.earlyStopCalls).toBe(1);
      expect(exitCalls).toContain(143);

      // Release the hung wait() so runPromise can complete and the
      // shutdown handlers detach via the finally block.
      probe.finishWait();
      await runPromise;
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).__test_signalProbe;
    }
  });
});
