// Why `globalThis.__SDK_VERSION__` and not a bare `__SDK_VERSION__`:
//   1. Safety. Reading a bare identifier that was never declared at runtime
//      throws `ReferenceError` (this is what happens under vitest, where
//      tsdown's `define` transform doesn't run). A property access on
//      `globalThis` is just a missing-property lookup and yields
//      `undefined`, so the `?? "0.0.0-dev"` fallback actually fires.
//   2. Lint compatibility. The previous `typeof X !== "undefined"` probe
//      tripped `unicorn/no-typeof-undefined`, whose auto-fix rewrites it
//      to `X !== undefined` — re-introducing the ReferenceError above.
//      Typing the global as `string | undefined` makes `?? fallback` a
//      "necessary" coalesce that no rule wants to strip.
// tsdown's `define` is keyed against the literal text `"globalThis.__SDK_VERSION__"`,
// so the whole member access is the replacement target at build time.
declare global {
  var __SDK_VERSION__: string | undefined;
}
export const SDK_VERSION: string = globalThis.__SDK_VERSION__ ?? "0.0.0-dev";
