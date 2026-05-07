import { fileURLToPath } from "node:url";

/**
 * Absolute path to the built `arkor` CLI entry. Resolved as a sibling
 * of the workspace `packages/arkor/dist/bin.mjs`. The package's
 * `pretest` hook builds `packages/arkor` (which also copies the bundled
 * studio assets into `dist/assets/`) before Playwright runs, so this
 * path always exists at test time.
 */
export const ARKOR_BIN = fileURLToPath(
  new URL("../../../../packages/arkor/dist/bin.mjs", import.meta.url),
);
