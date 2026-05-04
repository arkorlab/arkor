import { isArkor } from "./arkor";
import type { Arkor, JobConfig, Trainer, TrainerCallbacks } from "./types";

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
 * Replace the trainer's lifecycle callbacks atomically. The brand is
 * attached by `createTrainer`, but `runTrainer`'s `extractTrainer`
 * also accepts hand-rolled trainers (any `{ start, wait, cancel }`
 * shape) — those don't carry the brand. The HMR pipeline never
 * routes SIGUSR2 to such trainers in practice (they always produce
 * `configHash: null` upstream, which forces the SIGTERM-restart
 * path), so this helper is a no-op for them rather than throwing.
 */
export function replaceTrainerCallbacks(
  trainer: Trainer,
  callbacks: Partial<TrainerCallbacks>,
): void {
  const fn = (trainer as unknown as Record<symbol, unknown>)[
    TRAINER_REPLACE_CALLBACKS_KEY
  ] as ((cbs: Partial<TrainerCallbacks>) => void) | undefined;
  if (typeof fn !== "function") return;
  fn.call(trainer, callbacks);
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
 * Resolves once `cancel()` has been accepted by the cloud API, or
 * after `timeoutMs` if no checkpoint arrived in time.
 *
 * `createTrainer` attaches the brand unconditionally, but
 * `runTrainer`'s `extractTrainer` also accepts hand-rolled trainers
 * — any `{ start, wait, cancel }` shape — which legitimately don't
 * carry the brand. Falling back to the public `Trainer.cancel()` for
 * those is the closest semantic match available without the SDK's
 * checkpoint-aware machinery; it's also what the runner's SIGTERM
 * handler needs to keep working (the previous "throw if brand
 * missing" behaviour caused a synchronous TypeError before the
 * handler's `.catch().finally()` chain attached, so SIGTERM crashed
 * the runner instead of stopping the run).
 */
// async wrapper (rather than a bare function returning Promise) so
// any *synchronous* throw inside the brand call (or its arguments)
// becomes a rejected promise — the SIGTERM handler's `.catch()` then
// catches it instead of the throw escaping past the `.finally()`
// chain and taking the runner down.
export async function requestTrainerEarlyStop(
  trainer: Trainer,
  opts?: RequestEarlyStopOptions,
): Promise<void> {
  const fn = (trainer as unknown as Record<symbol, unknown>)[
    TRAINER_REQUEST_EARLY_STOP_KEY
  ] as ((opts?: RequestEarlyStopOptions) => Promise<void>) | undefined;
  if (typeof fn !== "function") {
    // Best-effort fallback for unbranded trainers: trainer.cancel()
    // is part of the public Trainer interface, so it's always safe
    // to call. Catch/swallow because the documented contract for
    // cancel() is "best-effort" and the SIGTERM handler needs the
    // returned promise to settle either way.
    try {
      await trainer.cancel();
    } catch {
      // intentionally ignored — see comment above.
    }
    return;
  }
  await fn.call(trainer, opts);
}

/**
 * Trainer-shaped value pulled from a re-imported bundle. We don't
 * import the public `Trainer` type here because consumers of this
 * helper want to read minimal fields (`name` for display) without
 * type-narrowing on the full SDK interface — many tests fabricate
 * hand-rolled trainer literals that don't structurally match
 * `Trainer` (no `requestEarlyStop` etc.) but are still legitimate
 * user shapes the runner accepts.
 */
type TrainerLike = { name?: unknown; [key: string]: unknown };

function isTrainerLike(value: unknown): value is TrainerLike {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.start === "function" &&
    typeof v.wait === "function" &&
    typeof v.cancel === "function"
  );
}

/**
 * Walk a freshly-imported user bundle in the same precedence order
 * as `runner.ts`'s `extractTrainer` and return the first
 * trainer-shaped value (anything that has `start`/`wait`/`cancel`
 * functions). Doesn't require the SDK inspection brand — the
 * manifest UI displays the trainer's `name` for hand-rolled trainers
 * too, even when HMR can't compute a `configHash` for them.
 *
 * The four supported shapes:
 *   1. `export const arkor = createArkor({ trainer })`
 *   2. `export const trainer = createTrainer(...)`  (bare named export)
 *   3. `export default createArkor({ trainer })`
 *   4. `export default { trainer: createTrainer(...) }`
 */
export function findTrainerInModule(
  mod: Record<string, unknown>,
): TrainerLike | null {
  const candidates: unknown[] = [];
  // 1: createArkor named export
  if (isArkor(mod.arkor) && (mod.arkor as Arkor).trainer) {
    candidates.push((mod.arkor as Arkor).trainer);
  }
  // 2: bare `trainer` named export
  if (mod.trainer) candidates.push(mod.trainer);
  // 3: default-export holding an Arkor manifest
  if (isArkor(mod.default) && (mod.default as Arkor).trainer) {
    candidates.push((mod.default as Arkor).trainer);
  }
  // 4: default.trainer nested
  if (
    mod.default &&
    typeof mod.default === "object" &&
    "trainer" in (mod.default as Record<string, unknown>)
  ) {
    candidates.push((mod.default as Record<string, unknown>).trainer);
  }
  for (const c of candidates) {
    if (isTrainerLike(c)) return c;
  }
  return null;
}

/**
 * Walk a freshly-imported user bundle and return the first inspection
 * snapshot we can pull off a discovered trainer. Used by both
 * `studio/hmr.ts` (computing the `configHash` for HMR routing) and
 * `core/runnerSignals.ts` (extracting new callbacks for SIGUSR2 hot-
 * swap) so the two paths stay in sync with the runner about which
 * export shapes count as "a trainer is exported here".
 *
 * Returns `null` when none of the candidates carry the inspection
 * brand — typically because the bundle has no SDK-built trainer
 * (hand-rolled trainer, fresh scaffold, syntax error, or a
 * third-party shape).
 */
export function findInspectableTrainer(
  mod: Record<string, unknown>,
): TrainerInspection | null {
  const trainer = findTrainerInModule(mod);
  return trainer ? getTrainerInspection(trainer) : null;
}
