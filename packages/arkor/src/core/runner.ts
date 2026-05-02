import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isArkor } from "./arkor";
import type { Trainer } from "./types";

const DEFAULT_ENTRY = "src/arkor/index.ts";

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

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Two-stage signal handling so HMR rebuilds (Studio sends SIGTERM) preserve
 * the in-flight checkpoint work:
 *
 *   - 1st signal → `trainer.requestEarlyStop()`. The trainer keeps running,
 *     lets the next `checkpoint.saved` event land, then issues `cancel()`.
 *   - 2nd signal → immediate `process.exit(143)`. Escape hatch for an
 *     impatient operator or a hung early-stop.
 *
 * The handlers are removed in `finally` so a normal `wait()` completion
 * doesn't leave stale listeners behind — important because `runTrainer` can
 * be called multiple times in tests within a single Node process.
 */
function installShutdownHandlers(trainer: Trainer): () => void {
  let signalCount = 0;
  const handler = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) {
      process.stdout.write(
        `Received second ${signal}; exiting without waiting for checkpoint.\n`,
      );
      process.exit(143);
      // Explicit return so test mocks of process.exit (which don't actually
      // terminate the worker) don't fall through into the early-stop path.
      return;
    }
    process.stdout.write(
      `Received ${signal}; early-stopping at next checkpoint…\n`,
    );
    trainer
      .requestEarlyStop()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`requestEarlyStop failed: ${msg}\n`);
      })
      .finally(() => process.exit(0));
  };
  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, handler);
  return () => {
    for (const sig of SHUTDOWN_SIGNALS) process.off(sig, handler);
  };
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

  const removeShutdownHandlers = installShutdownHandlers(trainer);
  try {
    const { jobId } = await trainer.start();
    process.stdout.write(`Started job ${jobId}\n`);
    const result = await trainer.wait();
    process.stdout.write(
      `Job ${result.job.id} finished with status=${result.job.status}\n`,
    );
  } finally {
    removeShutdownHandlers();
  }
}
