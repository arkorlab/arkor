import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCallbackReloadHandler,
  installShutdownHandlers,
} from "./runnerSignals";
import type { Trainer, TrainerCallbacks } from "./types";
import {
  attachTrainerCallbackReplacer,
  attachTrainerInspection,
} from "./trainerInspection";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-signals-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeTrainer(): Trainer & {
  __earlyStop: { calls: number };
  __replace: { lastCallbacks: Partial<TrainerCallbacks> | null };
} {
  const earlyStop = { calls: 0 };
  const replace = { lastCallbacks: null as Partial<TrainerCallbacks> | null };
  const trainer: Trainer = {
    name: "n",
    async start() {
      return { jobId: "j" };
    },
    async wait() {
      throw new Error("not used");
    },
    async cancel() {},
    async requestEarlyStop() {
      earlyStop.calls += 1;
    },
  };
  // Wire the internal callback-replacer brand the same way `createTrainer`
  // does. The SIGUSR2 path looks the brand up via `replaceTrainerCallbacks`
  // — there's no public method on `Trainer` for this any more.
  attachTrainerCallbackReplacer(trainer, (cbs) => {
    replace.lastCallbacks = cbs;
  });
  return Object.assign(trainer, {
    __earlyStop: earlyStop,
    __replace: replace,
  });
}

describe("installShutdownHandlers", () => {
  it("calls trainer.requestEarlyStop on the first SIGTERM and exit(0)", async () => {
    const trainer = makeTrainer();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never) as typeof process.exit);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    const dispose = installShutdownHandlers(trainer);
    try {
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setTimeout(r, 10));
      expect(trainer.__earlyStop.calls).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      dispose();
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("second SIGTERM exits 143 without re-invoking requestEarlyStop", async () => {
    const trainer = makeTrainer();
    const exitCodes: number[] = [];
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exitCodes.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    const dispose = installShutdownHandlers(trainer);
    try {
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setTimeout(r, 10));
      expect(trainer.__earlyStop.calls).toBe(1);
      expect(exitCodes).toContain(0);
      expect(exitCodes).toContain(143);
    } finally {
      dispose();
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});

describe("installCallbackReloadHandler", () => {
  function writeUserBundle(label: string): string {
    const file = join(cwd, "entry.mjs");
    // Inline a fake trainer that wears the inspection brand. The
    // SIGUSR2 handler dynamic-imports this file and pulls the
    // callbacks reference off via `getTrainerInspection`.
    const src = `
      const KEY = Symbol.for("arkor.trainer.inspect");
      const callbacks = { onLog: (ctx) => globalThis.__arkor_callbackProbe?.(${JSON.stringify(label)}, ctx) };
      const trainer = {
        name: "t",
        start: async () => ({ jobId: "j" }),
        wait: async () => ({ job: {}, artifacts: [] }),
        cancel: async () => {},
        requestEarlyStop: async () => {},
      };
      Object.defineProperty(trainer, KEY, {
        value: () => ({ name: "t", config: { model: "m", datasetSource: { type: "huggingface", name: "x" } }, callbacks }),
        enumerable: false,
      });
      export const arkor = Object.freeze({ _kind: "arkor", trainer });
    `;
    writeFileSync(file, src);
    return file;
  }

  it("re-imports the bundle and forwards the new callbacks via replaceCallbacks", async () => {
    const trainer = makeTrainer();
    // Brand the trainer too so the import path-side has a reference shape.
    attachTrainerInspection(trainer, () => ({
      name: "n",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      callbacks: {},
    }));

    const file = writeUserBundle("v1");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const dispose = installCallbackReloadHandler(trainer, file);
    mkdirSync(join(cwd, "src"), { recursive: true });
    try {
      // Rewrite the entry to "v2" callbacks before signalling.
      writeUserBundle("v2");
      process.emit("SIGUSR2", "SIGUSR2");
      // Wait for the dynamic import + replaceCallbacks to settle.
      for (let i = 0; i < 50 && trainer.__replace.lastCallbacks === null; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(trainer.__replace.lastCallbacks).not.toBeNull();
      expect(typeof trainer.__replace.lastCallbacks?.onLog).toBe("function");
    } finally {
      dispose();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("logs a skip warning when the bundle has no inspectable trainer", async () => {
    const trainer = makeTrainer();
    const file = join(cwd, "no-trainer.mjs");
    writeFileSync(file, "export const nothing = true;\n");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    const dispose = installCallbackReloadHandler(trainer, file);
    try {
      process.emit("SIGUSR2", "SIGUSR2");
      // Give the dynamic import a few ticks.
      await new Promise((r) => setTimeout(r, 50));
      expect(stderrChunks.join("")).toMatch(/no inspectable trainer/i);
      expect(trainer.__replace.lastCallbacks).toBeNull();
    } finally {
      dispose();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
