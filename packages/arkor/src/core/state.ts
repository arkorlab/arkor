import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
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

/**
 * Remove `.arkor/state.json` if it exists but is scoped to a different org
 * than `orgSlug`. Returns true when a stale file was removed.
 *
 * A previous (now logged-out) anonymous identity leaves project state scoped
 * to its own personal org behind: `arkor logout` only deletes the global
 * `~/.arkor/credentials.json`, never the per-project state file. Reusing that
 * scope with a freshly-minted anonymous identity makes every scoped cloud-api
 * call 403, because the new token isn't a member of the old identity's org.
 * `arkor dev` calls this right after bootstrapping a new anonymous session so
 * the Studio routes re-bootstrap under the new org instead of 403ing. It
 * automates the manual `rm .arkor/state.json` fix, but only when the identity
 * actually changed (a matching org is left untouched).
 */
export async function clearStaleProjectState(
  orgSlug: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  const existing = await readState(cwd);
  if (existing && existing.orgSlug !== orgSlug) {
    await rm(statePath(cwd), { force: true });
    return true;
  }
  return false;
}
