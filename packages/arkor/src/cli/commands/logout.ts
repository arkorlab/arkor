import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { credentialsPath, readCredentials } from "../../core/credentials";
import { promptConfirm, ui } from "../prompts";

export interface LogoutOptions {
  yes?: boolean;
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
  if (credentials?.mode === "anon") {
    ui.log.warn(ANONYMOUS_LOGOUT_WARNING);
  }
  const confirmed = await promptConfirm({
    message: `Delete ${path}?`,
    initialValue: false,
    skipWith: options.yes ? true : undefined,
  });
  if (!confirmed) {
    ui.log.info("Aborted.");
    return;
  }
  await rm(path, { force: true });
  ui.log.success(`Removed ${path}.`);
}
