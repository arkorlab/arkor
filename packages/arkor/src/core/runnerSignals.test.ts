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
  attachTrainerEarlyStopper,
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
  __replace: {
    lastCallbacks: Partial<TrainerCallbacks> | null;
    calls: number;
  };
} {
  const earlyStop = { calls: 0 };
  const replace = {
    lastCallbacks: null as Partial<TrainerCallbacks> | null,
    calls: 0,
  };
  const trainer: Trainer = {
    name: "n",
    async start() {
      return { jobId: "j" };
    },
    async wait() {
      throw new Error("not used");
    },
    async cancel() {},
  };
  // Wire the internal callback-replacer + early-stop brands the same
  // way `createTrainer` does. SIGUSR2 looks them up via
  // `replaceTrainerCallbacks` and SIGTERM via `requestTrainerEarlyStop`
  // — there are no public methods on `Trainer` for either any more.
  attachTrainerCallbackReplacer(trainer, (cbs) => {
    replace.lastCallbacks = cbs;
    replace.calls += 1;
  });
  attachTrainerEarlyStopper(trainer, async () => {
    earlyStop.calls += 1;
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

  it("second-signal exit code is per-signal POSIX 128+signo (130 for SIGINT, 129 for SIGHUP)", async () => {
    // Regression: the second-signal emergency-exit path used to
    // hardcode `process.exit(143)` regardless of which signal
    // fired. SIGINT (Ctrl-C twice) and SIGHUP shutdowns then
    // looked like SIGTERM exits to parent shells / orchestrators,
    // breaking signal-aware logic (e.g. tmux pane behaviour, CI
    // job classification, `&&` / `||` chains that distinguish
    // user-cancel from clean exit). Mirrors `SIGNAL_EXIT_CODE` in
    // `cli/cleanupHooks.ts`.
    const cases: Array<["SIGINT" | "SIGTERM" | "SIGHUP", number]> = [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ];
    for (const [sig, expectedExit] of cases) {
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
        process.emit(sig, sig);
        await new Promise((r) => setTimeout(r, 10));
        process.emit(sig, sig);
        await new Promise((r) => setTimeout(r, 10));
        // First signal exits 0 via the early-stop chain's
        // `.finally(() => process.exit(0))`; second signal exits
        // with the per-signal POSIX code.
        expect(exitCodes, `signal ${sig}`).toContain(expectedExit);
      } finally {
        dispose();
        exitSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
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

  it("returns a no-op disposer when SIGUSR2 registration throws (Windows fallback)", () => {
    // Regression: `process.on("SIGUSR2", ...)` can throw at
    // registration time on platforms that don't support the signal
    // (notably Windows). Previously this would surface as a hard
    // crash at `arkor start` boot. The handler now wraps the
    // registration in try/catch and degrades to a no-op disposer so
    // the rest of the runner stays up — the server's
    // `safeKill(child, "SIGUSR2")` already detects the same
    // condition and falls back to SIGTERM-restart there.
    const trainer = makeTrainer();
    const file = join(cwd, "entry.mjs");
    writeFileSync(file, "export const x = 1;\n");

    const realOn = process.on.bind(process);
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
        if (event === "SIGUSR2") {
          throw new Error("ENOSYS: function not implemented");
        }
        return realOn(event as never, listener as never);
      }) as typeof process.on);

    let dispose: (() => void) | undefined;
    try {
      // Must not throw despite the SIGUSR2 registration failure.
      dispose = installCallbackReloadHandler(trainer, file);
      expect(typeof dispose).toBe("function");
      // No listener was attached, so the disposer is a no-op; calling
      // it must not throw either (mirroring the success-path contract
      // for tests that always invoke the disposer in `finally`).
      expect(() => dispose?.()).not.toThrow();
    } finally {
      onSpy.mockRestore();
    }
  });

  it("drops a stale reload's result when a newer SIGUSR2 starts before the import resolves", async () => {
    // Regression: each SIGUSR2 starts a fire-and-forget
    // `import()` + `replaceTrainerCallbacks`. Two same-`configHash`
    // rebuilds firing back-to-back can race — the earlier import's
    // bytes sometimes resolve *after* the newer one, and
    // `replaceTrainerCallbacks` overwrites the freshly-loaded
    // callbacks with the prior version. The fix version-gates each
    // reload via a monotonic `loadSeq`; this test pins the contract
    // by firing two signals back-to-back and asserting that
    // `replaceTrainerCallbacks` was invoked exactly **once** —
    // proving the older IIFE dropped its result at the
    // `seq !== loadSeq` check before reaching the replace call.
    const trainer = makeTrainer();
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
    try {
      // First signal — captures seq=1 inside the IIFE.
      process.emit("SIGUSR2", "SIGUSR2");
      // Rewrite the bundle to v2 BEFORE letting either import
      // resolve. mtime+ctime+size change → distinct cache-bust URL.
      writeUserBundle("v2");
      // Second signal — captures seq=2, bumps loadSeq to 2.
      process.emit("SIGUSR2", "SIGUSR2");
      // Generous fixed wait so both imports definitely settle —
      // we can't poll on `lastCallbacks !== null` because the v1
      // IIFE might land first and short-circuit our wait, hiding
      // the count assertion below.
      await new Promise((r) => setTimeout(r, 200));
      // Without the seq guard, both IIFEs would call
      // `replaceTrainerCallbacks` and `calls` would be 2. With the
      // guard, the older IIFE's `seq !== loadSeq` short-circuit
      // skips the replace call entirely.
      expect(trainer.__replace.calls).toBe(1);
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
