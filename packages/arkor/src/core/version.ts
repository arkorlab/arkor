// `__SDK_VERSION__` is replaced at build time by tsdown's `define` from
// package.json. The runtime fallback only fires under `vitest` (which doesn't
// run tsdown's transform) so unit tests don't crash on `ReferenceError`.
declare const __SDK_VERSION__: string;
export const SDK_VERSION: string =
  typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "0.0.0-dev";
