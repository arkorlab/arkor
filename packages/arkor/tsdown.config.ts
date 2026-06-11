/// <reference types="node" />
import { defineConfig } from "tsdown";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  tsconfig: "./tsconfig.build.json",
  // `@arkor/cli-internal` is a private workspace package: bundle its source
  // into the published tarball so consumers don't depend on something that
  // isn't on npm.
  deps: {
    alwaysBundle: ["@arkor/cli-internal"],
  },
  // Inline build-time constants. Why keys are `"globalThis.__X__"`
  // (property-access form) and not bare `__X__`:
  //   1. Safety at the consumer side. Source reads the value as
  //      `globalThis.__X__ ?? fallback`. A bare `__X__` reference would
  //      throw `ReferenceError` whenever this transform doesn't run
  //      (vitest, ad-hoc `node --import tsx` invocations, etc.) because
  //      the identifier is genuinely undeclared at runtime. A property
  //      access on `globalThis` is a missing-property lookup, so the
  //      fallback wins instead of the program crashing.
  //   2. Lint compatibility. The `typeof X !== "undefined"` probe that
  //      used to guard the bare-identifier form tripped
  //      `unicorn/no-typeof-undefined`, whose auto-fix would have
  //      reintroduced (1).
  // The replacement matches the literal source expression, so source and
  // define key must stay in lock-step (e.g. renaming one side requires
  // renaming the other).
  define: {
    "globalThis.__SDK_VERSION__": JSON.stringify(pkg.version),
    "globalThis.__ARKOR_POSTHOG_KEY__": JSON.stringify(
      process.env.ARKOR_POSTHOG_KEY ?? "",
    ),
    "globalThis.__ARKOR_POSTHOG_HOST__": JSON.stringify(
      process.env.ARKOR_POSTHOG_HOST ?? "https://us.i.posthog.com",
    ),
  },
});
