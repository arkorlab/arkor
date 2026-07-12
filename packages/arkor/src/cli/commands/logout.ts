import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { credentialsPath, readCredentials } from "../../core/credentials";
import { promptConfirm, ui } from "../prompts";

export interface LogoutOptions {
  force?: boolean;
}

const ANONYMOUS_LOGOUT_WARNING =
  "Anonymous credentials cannot be restored after logout. Deleting them permanently loses access to this anonymous identity.";

export async function runLogout(options: LogoutOptions = {}): Promise<void> {
  const path = credentialsPath();
  if (!existsSync(path)) {
    ui.log.info("No credentials on file.");
    return;
  }
  const credentials = await readCredentials().catch(() => null);
  const isAnonymous = credentials?.mode === "anon";
  const confirmed = await promptConfirm({
    message: isAnonymous
      ? `${ANONYMOUS_LOGOUT_WARNING} Delete ${path}?`
      : `Delete ${path}?`,
    initialValue: false,
    skipWith: options.force ? true : undefined,
  });
  if (!confirmed) {
    ui.log.info("Aborted.");
    return;
  }
  if (isAnonymous && options.force) {
    ui.log.warn(ANONYMOUS_LOGOUT_WARNING);
  }
  await rm(path, { force: true });
  ui.log.success(`Removed ${path}.`);
}
