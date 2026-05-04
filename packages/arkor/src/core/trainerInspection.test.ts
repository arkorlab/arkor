import { describe, it, expect } from "vitest";
import { createArkor } from "./arkor";
import { createTrainer } from "./trainer";
import {
  findInspectableTrainer,
  findTrainerInModule,
  getTrainerInspection,
} from "./trainerInspection";

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
