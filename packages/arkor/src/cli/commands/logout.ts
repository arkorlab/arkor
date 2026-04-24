import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { credentialsPath } from "../../core/credentials";
import { promptConfirm, ui } from "../prompts";

export interface LogoutOptions {
  yes?: boolean;
}

export async function runLogout(options: LogoutOptions = {}): Promise<void> {
  const path = credentialsPath();
  if (!existsSync(path)) {
    ui.log.info("No credentials on file.");
    return;
  }
  const confirmed = await promptConfirm({
    message: `Delete ${path}?`,
    initialValue: true,
    skipWith: options.yes ? true : undefined,
  });
  if (!confirmed) {
    ui.log.info("Aborted.");
    return;
  }
  await rm(path, { force: true });
  ui.log.success(`Removed ${path}.`);
}
