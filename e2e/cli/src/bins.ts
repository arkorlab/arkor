import { fileURLToPath } from "node:url";

/** Path to the built `create-arkor` CLI entry. The `pretest` hook builds it. */
export const CREATE_ARKOR_BIN = fileURLToPath(
  new URL("../../../packages/create-arkor/dist/bin.mjs", import.meta.url),
);

/** Path to the built `arkor` CLI entry. The `pretest` hook builds it. */
export const ARKOR_BIN = fileURLToPath(
  new URL("../../../packages/arkor/dist/bin.mjs", import.meta.url),
);
