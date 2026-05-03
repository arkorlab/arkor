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
  // Inline the package version so `core/version.ts` reports a real value
  // without a runtime JSON import. The fallback in `version.ts` only fires
  // under vitest, where this transform doesn't run.
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
    __ARKOR_POSTHOG_KEY__: JSON.stringify(process.env.ARKOR_POSTHOG_KEY ?? ""),
    __ARKOR_POSTHOG_HOST__: JSON.stringify(
      process.env.ARKOR_POSTHOG_HOST ?? "https://us.i.posthog.com",
    ),
  },
});
