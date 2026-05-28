import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { isArkor } from "./arkor";
import {
  installCallbackReloadHandler,
  installShutdownHandlers,
} from "./runnerSignals";
import type { Trainer } from "./types";

const DEFAULT_ENTRY = "src/arkor/index.ts";

/**
 * Per-spawn nonce that `/api/train` injects via env so the server can
 * recognise the runner's `Started job <id>` line without it being
 * forgeable from user code. Captured at module load (i.e. BEFORE
 * `runTrainer` does its `await import(userEntry)`) and the env var
 * is deleted right after so the dynamically-imported user module
 * cannot read it via `process.env`. If a user callback then writes
 * `Started job <token>` to stdout, the line won't carry the nonce
 * prefix and the server's anchored regex will reject it: no
 * spoofed cloud `cancel()` POST against an attacker-chosen job id.
 *
 * Null when the runner was launched directly (e.g. `arkor start` from
 * a shell), in which case the runner falls back to the plain
 * `Started job <id>` form for backwards compatibility. The server only
 * uses the nonce-prefixed form because every server spawn sets the
 * env var.
 *
 * **Import-order requirement.** The spoof-prevention guarantee relies
 * on this module reading + deleting `ARKOR_JOB_ID_MARKER_NONCE`
 * before any user-controlled module gets to touch `process.env`.
 * That's safe today because the only consumer chain is
 * `bin.ts → cli/main.ts → cli/commands/start.ts → core/runner.ts`,
 * all static imports, so this module is fully evaluated before
 * `runTrainer` performs its `await import(userEntry)`. If a future
 * refactor introduces a dynamic-import / lazy-load of runner.ts (so
 * a sibling module runs first and could snapshot `process.env`), the
 * capture+delete should move into a tiny dedicated module that the
 * bin imports first, or the env var should be wiped at the server
 * spawn boundary too.
 */
// Normalise empty/whitespace-only env values to null so we don't emit a
// spoofable `[arkor:] Started job ...` prefix (zero-length nonce) when
// the server happens to pass an empty string. The server always writes
// 32 hex chars, but a future caller / mis-launch shouldn't be able to
// accidentally turn the nonce-prefixed marker into a forgeable form by
// supplying `""`.
const RAW_STARTED_JOB_NONCE = process.env.ARKOR_JOB_ID_MARKER_NONCE;
const STARTED_JOB_NONCE: string | null =
  typeof RAW_STARTED_JOB_NONCE === "string" && RAW_STARTED_JOB_NONCE.trim() !== ""
    ? RAW_STARTED_JOB_NONCE
    : null;
delete process.env.ARKOR_JOB_ID_MARKER_NONCE;

function isTrainer(value: unknown): value is Trainer {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.start === "function" &&
    typeof t.wait === "function" &&
    typeof t.cancel === "function"
  );
}

function trainerFromValue(value: unknown): Trainer | null {
  if (isArkor(value) && value.trainer && isTrainer(value.trainer)) {
    return value.trainer;
  }
  if (isTrainer(value)) return value;
  return null;
}

function extractTrainer(mod: Record<string, unknown>): Trainer {
  // Preferred (new): `arkor` named export from createArkor({...}).
  const fromArkor = trainerFromValue(mod.arkor);
  if (fromArkor) return fromArkor;
  // Power-user shortcut: a bare `trainer` export.
  if (isTrainer(mod.trainer)) return mod.trainer;
  // Fallback: default export holding either an Arkor manifest or a Trainer.
  const fromDefault = trainerFromValue(mod.default);
  if (fromDefault) return fromDefault;
  if (mod.default && typeof mod.default === "object") {
    const nested = (mod.default as Record<string, unknown>).trainer;
    if (isTrainer(nested)) return nested;
  }
  throw new Error(
    "Training entry must export `arkor` (from createArkor({...})) or `trainer` (from createTrainer({...})), or default-export one of them.",
  );
}

export async function runTrainer(file?: string): Promise<void> {
  const relative = file ?? DEFAULT_ENTRY;
  const abs = isAbsolute(relative) ? relative : resolve(process.cwd(), relative);
  if (!existsSync(abs)) {
    throw new Error(
      `Training entry not found: ${abs}. Provide a path or create ${DEFAULT_ENTRY}.`,
    );
  }
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const trainer = extractTrainer(mod);

  const removeShutdown = installShutdownHandlers(trainer);
  const removeCallbackReload = installCallbackReloadHandler(trainer, abs);
  try {
    const { jobId } = await trainer.start();
    const startedJobPrefix = STARTED_JOB_NONCE
      ? `[arkor:${STARTED_JOB_NONCE}] `
      : "";
    process.stdout.write(`${startedJobPrefix}Started job ${jobId}\n`);
    const result = await trainer.wait();
    process.stdout.write(
      `Job ${result.job.id} finished with status=${result.job.status}\n`,
    );
  } finally {
    removeShutdown();
    removeCallbackReload();
  }
}
