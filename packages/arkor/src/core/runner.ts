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
    process.stdout.write(`Started job ${jobId}\n`);
    const result = await trainer.wait();
    process.stdout.write(
      `Job ${result.job.id} finished with status=${result.job.status}\n`,
    );
  } finally {
    removeShutdown();
    removeCallbackReload();
  }
}
