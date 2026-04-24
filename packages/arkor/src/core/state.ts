import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArkorProjectState } from "./types";

const STATE_DIR = ".arkor";
const STATE_FILE = "state.json";

export function statePath(cwd: string = process.cwd()): string {
  return join(cwd, STATE_DIR, STATE_FILE);
}

export async function readState(
  cwd: string = process.cwd(),
): Promise<ArkorProjectState | null> {
  const p = statePath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    const data = JSON.parse(raw) as Partial<ArkorProjectState>;
    if (
      typeof data.orgSlug === "string" &&
      typeof data.projectSlug === "string" &&
      typeof data.projectId === "string"
    ) {
      return data as ArkorProjectState;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeState(
  state: ArkorProjectState,
  cwd: string = process.cwd(),
): Promise<void> {
  await mkdir(join(cwd, STATE_DIR), { recursive: true });
  await writeFile(statePath(cwd), JSON.stringify(state, null, 2) + "\n");
}
