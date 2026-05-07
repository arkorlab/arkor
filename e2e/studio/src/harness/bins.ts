import { fileURLToPath } from "node:url";

/**
 * Absolute path to the built `arkor` CLI entry. Resolved as a sibling
 * of the workspace `packages/arkor/dist/bin.mjs`. The artifact is
 * produced by `arkor#build`, which `arkor` is declared as a workspace
 * `devDependencies` of `@arkor/e2e-studio` so Turbo's `^build` runs
 * it before `@arkor/e2e-studio#test`. For standalone runs
 * (`pnpm --filter @arkor/e2e-studio test`) the contributor docs tell
 * the user to `pnpm build` first; if either route was skipped the
 * fixture's `arkor dev` spawn fails fast with `MODULE_NOT_FOUND` on
 * this path.
 */
export const ARKOR_BIN = fileURLToPath(
  new URL("../../../../packages/arkor/dist/bin.mjs", import.meta.url),
);
