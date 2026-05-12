import type { PackageManager } from "./package-manager";

/**
 * Manual hints printed in the "Next steps:" outro after `create-arkor` /
 * `arkor init` when the package manager could not be auto-detected (no
 * `--use-*` flag, no `npm_config_user_agent`). They list the form for
 * every supported package manager so the reader can pick.
 *
 * Also: a single shared `runArkorDevViaPm` helper that maps a known PM to
 * its runner-form equivalent of `arkor dev`, used when the project's
 * `scripts.dev` was preserved by the scaffolder and points elsewhere.
 *
 * Centralising these in `@arkor/cli-internal` is what keeps the
 * `create-arkor` and `arkor init` commands from drifting in their wording.
 */

export const MANUAL_INSTALL_HINT =
  "install dependencies (npm i / pnpm install / yarn / bun install)";

export const MANUAL_DEV_HINT =
  "run dev (npm run dev / pnpm dev / yarn dev / bun dev)";

export const MANUAL_RUN_ARKOR_DEV_HINT =
  "run arkor dev (npx arkor dev / pnpm exec arkor dev / yarn run arkor dev / bunx arkor dev)";

export function runArkorDevViaPm(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npx arkor dev";
    case "pnpm":
      return "pnpm exec arkor dev";
    case "yarn":
      return "yarn run arkor dev";
    case "bun":
      return "bunx arkor dev";
    default: {
      const _exhaustive: never = pm;
      throw new Error(`Unhandled package manager: ${String(_exhaustive)}`);
    }
  }
}
