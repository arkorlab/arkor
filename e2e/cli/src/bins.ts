import { fileURLToPath } from "node:url";

/**
 * Path to the built `create-arkor` CLI entry. `create-arkor` is
 * declared as a workspace `devDependencies` of `@arkor/e2e-cli`, so
 * Turbo's `^build` produces this artifact before
 * `@arkor/e2e-cli#test` (and `#test:coverage`) runs. Coverage runs
 * additionally need `create-arkor`'s tsdown to emit sourcemaps so c8
 * can remap V8 hits back to `src/`; that's gated on
 * `CREATE_ARKOR_BUILD_SOURCEMAP=1`, which is *not* set by this
 * package's `test:coverage` script — CI's coverage job (or an
 * explicit caller, see `CONTRIBUTING.md`) sets it on the parent
 * environment, and turbo.json's `build`/`test:coverage` env
 * allowlist propagates it into `create-arkor#build`. For standalone
 * runs (`pnpm --filter @arkor/e2e-cli test`) the contributor docs
 * ask the user to `pnpm build` first; if either route was skipped
 * the test fails fast with `MODULE_NOT_FOUND` on this path.
 */
export const CREATE_ARKOR_BIN = fileURLToPath(
  new URL("../../../packages/create-arkor/dist/bin.mjs", import.meta.url),
);

/**
 * Path to the built `arkor` CLI entry. Produced by `arkor#build`
 * via the same workspace-dep + Turbo `^build` chain as
 * `CREATE_ARKOR_BIN` above.
 */
export const ARKOR_BIN = fileURLToPath(
  new URL("../../../packages/arkor/dist/bin.mjs", import.meta.url),
);
