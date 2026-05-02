import type { JobConfig, TrainerCallbacks } from "./types";

/**
 * Snapshot of a trainer's identity and cloud-side config that the Studio
 * server reads in order to (a) compute a stable hash for HMR's
 * "callbacks-only vs full restart" decision and (b) extract the new
 * callbacks reference when hot-swapping.
 *
 * **Internal API — not part of the user-facing SDK surface.** Both this
 * snapshot and the companion `replaceTrainerCallbacks` mutator are
 * exposed only via `Symbol.for(...)`-keyed properties on the trainer
 * object so they don't appear on the public `Trainer` type. They exist
 * to let `arkor dev`'s HMR pipeline hot-swap callbacks without
 * restarting cloud-side training; user code shouldn't call them
 * directly.
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
const TRAINER_REPLACE_CALLBACKS_KEY = Symbol.for(
  "arkor.trainer.replaceCallbacks",
);
const TRAINER_REQUEST_EARLY_STOP_KEY = Symbol.for(
  "arkor.trainer.requestEarlyStop",
);

export interface RequestEarlyStopOptions {
  /** Default: 5 min. Falls back to immediate cancel if no checkpoint arrives. */
  timeoutMs?: number;
}

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

/**
 * Wire the trainer's mutable callbacks slot to a `Symbol.for`-keyed
 * brand so the runner subprocess can hot-swap callbacks without us
 * exposing the operation on the public `Trainer` interface. Called once
 * from `createTrainer`.
 */
export function attachTrainerCallbackReplacer(
  trainer: object,
  replace: (callbacks: Partial<TrainerCallbacks>) => void,
): void {
  Object.defineProperty(trainer, TRAINER_REPLACE_CALLBACKS_KEY, {
    value: replace,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Replace the trainer's lifecycle callbacks atomically. Returns `true`
 * when the call landed (the trainer carried the brand), `false`
 * otherwise — callers (the SIGUSR2 hot-swap path in `runnerSignals`)
 * use the return value to decide whether to log a skip warning.
 */
export function replaceTrainerCallbacks(
  trainer: unknown,
  callbacks: Partial<TrainerCallbacks>,
): boolean {
  if (!trainer || typeof trainer !== "object") return false;
  const fn = (trainer as Record<symbol, unknown>)[
    TRAINER_REPLACE_CALLBACKS_KEY
  ];
  if (typeof fn !== "function") return false;
  try {
    (fn as (cbs: Partial<TrainerCallbacks>) => void).call(trainer, callbacks);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire an early-stop entry point onto a `Trainer` so the SIGTERM handler
 * in the runner subprocess can request a graceful "stop after the next
 * checkpoint" without us exposing the operation on the public `Trainer`
 * interface. User code that wants the same semantics should compose
 * the cookbook's `abortSignal` + `cancel()` recipe instead — see
 * `docs/cookbook/early-stopping.mdx`.
 */
export function attachTrainerEarlyStopper(
  trainer: object,
  requestStop: (opts?: RequestEarlyStopOptions) => Promise<void>,
): void {
  Object.defineProperty(trainer, TRAINER_REQUEST_EARLY_STOP_KEY, {
    value: requestStop,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Request that the trainer stop after the next saved checkpoint.
 * Returns the same promise the underlying implementation hands out —
 * resolves once `cancel()` has been accepted by the cloud API, or
 * after `timeoutMs` if no checkpoint arrived in time.
 *
 * Returns `null` when the trainer doesn't carry the early-stop brand
 * (third-party wrapper / pre-SDK shape) so callers can decide whether
 * to fall back to a hard kill.
 */
export function requestTrainerEarlyStop(
  trainer: unknown,
  opts?: RequestEarlyStopOptions,
): Promise<void> | null {
  if (!trainer || typeof trainer !== "object") return null;
  const fn = (trainer as Record<symbol, unknown>)[
    TRAINER_REQUEST_EARLY_STOP_KEY
  ];
  if (typeof fn !== "function") return null;
  try {
    const result = (
      fn as (opts?: RequestEarlyStopOptions) => Promise<void>
    ).call(trainer, opts);
    return Promise.resolve(result);
  } catch (err) {
    return Promise.reject(err);
  }
}
