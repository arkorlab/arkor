import { describe, expect, it, vi } from "vitest";
import { createArkor } from "./arkor";
import { createTrainer } from "./trainer";
import {
  findInspectableTrainer,
  findTrainerInModule,
  getTrainerInspection,
  replaceTrainerCallbacks,
  requestTrainerEarlyStop,
} from "./trainerInspection";
import type { Trainer } from "./types";

function brandedTrainer(name: string) {
  // Real `createTrainer` attaches the inspection brand. We only need
  // a no-op trainer for these shape tests — `start`/`wait` etc. are
  // never invoked.
  return createTrainer({
    name,
    model: "m",
    dataset: { type: "huggingface", name: "x" },
  });
}

function unbrandedTrainer(name: string) {
  // Hand-rolled trainer — passes the `start`/`wait`/`cancel` shape
  // check `findTrainerInModule` requires but DOESN'T carry the SDK
  // inspection brand. Mirrors a user who wraps or re-exports a
  // trainer outside the SDK helpers.
  return {
    name,
    start: async () => ({ jobId: "j" }),
    wait: async () => ({ job: {}, artifacts: [] }),
    cancel: async () => {},
  };
}

describe("findTrainerInModule (trainer-shape walk)", () => {
  it("finds shape #1: createArkor named export", () => {
    const trainer = brandedTrainer("a");
    const found = findTrainerInModule({ arkor: createArkor({ trainer }) });
    expect(found).toBe(trainer);
  });

  it("finds shape #2: bare `trainer` named export", () => {
    const trainer = brandedTrainer("b");
    const found = findTrainerInModule({ trainer });
    expect(found).toBe(trainer);
  });

  it("finds shape #3: default-export Arkor manifest", () => {
    const trainer = brandedTrainer("c");
    const found = findTrainerInModule({ default: createArkor({ trainer }) });
    expect(found).toBe(trainer);
  });

  it("finds shape #4: default.trainer nested", () => {
    const trainer = brandedTrainer("d");
    const found = findTrainerInModule({ default: { trainer } });
    expect(found).toBe(trainer);
  });

  it("works for hand-rolled (unbranded) trainers in any of the four shapes", () => {
    const trainer = unbrandedTrainer("manual");
    expect(findTrainerInModule({ trainer })?.name).toBe("manual");
    expect(findTrainerInModule({ default: { trainer } })?.name).toBe("manual");
  });

  it("returns null when no candidate looks like a trainer", () => {
    expect(findTrainerInModule({})).toBeNull();
    expect(findTrainerInModule({ arkor: {} })).toBeNull();
    expect(findTrainerInModule({ trainer: { name: "no-methods" } })).toBeNull();
    expect(findTrainerInModule({ default: 42 })).toBeNull();
  });
});

describe("findInspectableTrainer (brand-required path)", () => {
  it("returns the inspection snapshot for a branded trainer in any shape", () => {
    // Regression: previously HMR's `inspectBundle` only checked
    // `mod.arkor ?? mod.default`, missing shapes #2 and #4. As a
    // result, projects bare-exporting `trainer` always produced
    // `configHash: null` and HMR conservatively SIGTERM-restarted on
    // every rebuild — never hot-swapping callbacks. The fix routes
    // through `findInspectableTrainer` which walks every supported
    // shape via `findTrainerInModule` and pulls inspection off the
    // discovered trainer.
    const trainerA = brandedTrainer("from-arkor");
    const inspectionA = findInspectableTrainer({
      arkor: createArkor({ trainer: trainerA }),
    });
    expect(inspectionA?.name).toBe("from-arkor");

    const trainerB = brandedTrainer("bare-named");
    const inspectionB = findInspectableTrainer({ trainer: trainerB });
    expect(inspectionB?.name).toBe("bare-named");

    const trainerC = brandedTrainer("default-arkor");
    const inspectionC = findInspectableTrainer({
      default: createArkor({ trainer: trainerC }),
    });
    expect(inspectionC?.name).toBe("default-arkor");

    const trainerD = brandedTrainer("default-nested");
    const inspectionD = findInspectableTrainer({
      default: { trainer: trainerD },
    });
    expect(inspectionD?.name).toBe("default-nested");
  });

  it("returns null when only an unbranded trainer is present", () => {
    // Hand-rolled trainers don't carry the SDK inspection brand, so
    // HMR can't compute their `configHash`. The Studio still shows
    // the trainer name (via `findTrainerInModule` in
    // `summariseBuiltManifest`), but HMR routing falls back to the
    // SIGTERM-restart-everything path — which is the documented
    // safe behaviour when configs can't be diffed.
    const trainer = unbrandedTrainer("plain");
    expect(findInspectableTrainer({ trainer })).toBeNull();
    expect(getTrainerInspection(trainer)).toBeNull();
  });
});

describe("requestTrainerEarlyStop / replaceTrainerCallbacks brand-missing fallback", () => {
  // Regression: previously these helpers asserted the brand was
  // present and threw a synchronous TypeError on hand-rolled trainers.
  // `runner.ts`'s `extractTrainer` accepts ANY `{start, wait, cancel}`
  // shape — that's a documented public path for unbranded trainers —
  // so the SIGTERM handler crashed instead of stopping the run.

  it("requestTrainerEarlyStop falls back to trainer.cancel() for unbranded trainers", async () => {
    const cancelCalls = vi.fn(async () => {});
    const trainer = {
      name: "manual",
      start: async () => ({ jobId: "j" }),
      wait: async () => ({ job: {}, artifacts: [] }),
      cancel: cancelCalls,
    } as unknown as Trainer;

    // Must not throw, must resolve, must have called cancel().
    await expect(requestTrainerEarlyStop(trainer)).resolves.toBeUndefined();
    expect(cancelCalls).toHaveBeenCalledTimes(1);
  });

  it("requestTrainerEarlyStop swallows a thrown cancel() so the SIGTERM handler can still settle", async () => {
    // The runner's SIGTERM handler chains
    // `requestTrainerEarlyStop(...).catch(...).finally(() => process.exit(0))`.
    // If the brand-missing fallback let cancel()'s rejection bubble,
    // the `.finally` would still fire, but the cancel error would
    // surface as an unhandled rejection from the test runner. The
    // documented contract for cancel() is best-effort, so swallow.
    const trainer = {
      name: "manual",
      start: async () => ({ jobId: "j" }),
      wait: async () => ({ job: {}, artifacts: [] }),
      cancel: vi.fn(async () => {
        throw new Error("network down");
      }),
    } as unknown as Trainer;

    await expect(requestTrainerEarlyStop(trainer)).resolves.toBeUndefined();
  });

  it("requestTrainerEarlyStop is async-shaped: synchronous throws inside the brand call become rejections", async () => {
    // Defense-in-depth: even when the brand IS attached but somehow
    // throws synchronously (e.g. a future implementation regression),
    // the SIGTERM handler's `.catch` arm should still see it instead
    // of the throw escaping past `.finally` and taking the runner
    // down. The function is `async`, which wraps any synchronous
    // throw inside its body into a rejected promise.
    const trainer = brandedTrainer("from-arkor");
    // Replace the brand with a function that throws synchronously.
    const KEY = Symbol.for("arkor.trainer.requestEarlyStop");
    Object.defineProperty(trainer, KEY, {
      value: () => {
        throw new Error("brand impl exploded");
      },
      configurable: true,
    });
    await expect(requestTrainerEarlyStop(trainer)).rejects.toThrow(
      /brand impl exploded/,
    );
  });

  it("replaceTrainerCallbacks is a no-op (not a throw) for unbranded trainers", () => {
    // The HMR pipeline never routes SIGUSR2 to unbranded trainers in
    // practice (their `configHash` is null, which forces the
    // SIGTERM-restart path), but if a future caller did, it must not
    // crash the runner.
    const trainer = {
      name: "manual",
      start: async () => ({ jobId: "j" }),
      wait: async () => ({ job: {}, artifacts: [] }),
      cancel: async () => {},
    } as unknown as Trainer;
    expect(() =>
      replaceTrainerCallbacks(trainer, { onLog: () => {} }),
    ).not.toThrow();
  });
});
