import type { JobConfig, TrainerCallbacks } from "./types";

/**
 * Snapshot of a trainer's identity and cloud-side config that the Studio
 * server reads in order to (a) compute a stable hash for HMR's
 * "callbacks-only vs full restart" decision and (b) extract the new
 * callbacks reference when hot-swapping.
 */
export interface TrainerInspection {
  /** Run name (mirror of `Trainer.name`, copied for forward compatibility). */
  name: string;
  /** The cloud-side `JobConfig` this trainer would submit on `start()`. */
  config: JobConfig;
  /** Whatever the user passed in `input.callbacks`. May be empty. */
  callbacks: Partial<TrainerCallbacks>;
}

/**
 * The CLI runtime (`dist/bin.mjs`) and the user's compiled bundle
 * (`.arkor/build/index.mjs`, which keeps `arkor` external) end up loading
 * two separate copies of this SDK as distinct ESM module records — so a
 * module-local `WeakMap<Trainer, ...>` would split into two halves that
 * can't see each other.
 *
 * `Symbol.for(key)` is the cross-realm equivalent: the same key string
 * resolves to the same symbol in any module instance, so the trainer
 * created in the user's bundle exposes its inspection through the same
 * property the Studio process reads.
 */
const TRAINER_INSPECTION_KEY = Symbol.for("arkor.trainer.inspect");

/**
 * Stamp the inspection snapshot onto a freshly-built `Trainer` instance.
 * Called once from `createTrainer`. Stored as a thunk so callers can
 * read a fresh copy each time (defensive: the trainer's callbacks cell
 * is mutable across the lifetime of a hot-swap).
 */
export function attachTrainerInspection(
  trainer: object,
  read: () => TrainerInspection,
): void {
  Object.defineProperty(trainer, TRAINER_INSPECTION_KEY, {
    value: read,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Pull the snapshot off a Trainer-like value. Returns `null` for plain
 * objects that don't carry the brand — used by the Studio server to
 * gracefully ignore third-party wrappers or pre-SDK shapes.
 */
export function getTrainerInspection(
  trainer: unknown,
): TrainerInspection | null {
  if (!trainer || typeof trainer !== "object") return null;
  const fn = (trainer as Record<symbol, unknown>)[TRAINER_INSPECTION_KEY];
  if (typeof fn !== "function") return null;
  try {
    const result = (fn as () => unknown).call(trainer);
    if (
      result &&
      typeof result === "object" &&
      "config" in result &&
      "name" in result
    ) {
      return result as TrainerInspection;
    }
  } catch {
    // Inspection is best-effort; a thrown user callback shouldn't crash HMR.
  }
  return null;
}
