// Why `globalThis.__SDK_VERSION__` and not a bare `__SDK_VERSION__`:
//   1. Safety. Reading a bare identifier that was never declared at runtime
//      throws `ReferenceError` (this is what happens under vitest, where
//      tsdown's `define` transform doesn't run). A property access on
//      `globalThis` is just a missing-property lookup and yields
//      `undefined`, so the `?? "0.0.0-dev"` fallback actually fires.
//   2. Lint compatibility. The previous `typeof X !== "undefined"` probe
//      tripped `unicorn/no-typeof-undefined`, whose auto-fix rewrites it
//      to `X !== undefined`, re-introducing the ReferenceError above.
//      Typing the global as `string | undefined` makes `?? fallback` a
//      "necessary" coalesce that no rule wants to strip.
// tsdown's `define` is keyed against the literal text `"globalThis.__SDK_VERSION__"`,
// so the whole member access is the replacement target at build time.
//
// Two earlier shapes don't work here:
//   - `declare global { var __SDK_VERSION__: ... }` adds the symbol to
//     the bare-identifier namespace of every SDK consumer, polluting
//     their global types with our build constant.
//   - `(globalThis as { __SDK_VERSION__?: ... }).__SDK_VERSION__` keeps
//     the type local, but rolldown's `define` only rewrites a bare
//     `globalThis.X` member expression: wrapping `globalThis` in a
//     cast breaks the AST match and the version stops getting inlined
//     (`undefined ?? "0.0.0-dev"` at runtime in every build).
// Suppress the type error at the read site and assign through an
// explicitly-typed local so the resulting value isn't `any`. The
// property is undeclared on `globalThis` for consumers (no namespace
// pollution) and `?? "0.0.0-dev"` covers the missing-property case
// under vitest.
// @ts-expect-error: `globalThis.__SDK_VERSION__` is a tsdown `define`
// constant supplied at build time; intentionally not declared.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const inlinedSdkVersion: string | undefined = globalThis.__SDK_VERSION__;
export const SDK_VERSION: string = inlinedSdkVersion ?? "0.0.0-dev";
