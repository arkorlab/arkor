import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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

function extractTrainer(mod: Record<string, unknown>): Trainer {
  // Preferred: named export `trainer`. Fallback: `default` export.
  if (isTrainer(mod.trainer)) return mod.trainer;
  const def = mod.default as unknown;
  if (isTrainer(def)) return def;
  if (def && typeof def === "object") {
    const t = (def as Record<string, unknown>).trainer;
    if (isTrainer(t)) return t;
  }
  throw new Error(
    "Training entry must default-export (or export `trainer`) the result of createTrainer(...).",
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

  const { jobId } = await trainer.start();
  process.stdout.write(`Started job ${jobId}\n`);
  const result = await trainer.wait();
  process.stdout.write(`Job ${result.job.id} finished with status=${result.job.status}\n`);
}
