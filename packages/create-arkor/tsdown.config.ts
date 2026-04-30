/// <reference types="node" />
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  minify: true,
  // Default-off: the published `create-arkor` tarball intentionally ships
  // without sourcemaps (it's a one-shot scaffolder; users never debug into
  // it, and we want a minimum-size tarball). The E2E coverage path opts in
  // by setting `CREATE_ARKOR_BUILD_SOURCEMAP=1` (see e2e/cli's
  // `pretest:coverage`) so c8 can remap dist/bin.mjs hits back to
  // src/bin.ts. The published `pnpm --filter create-arkor build` invoked by
  // the release workflow does NOT set this, so no `.map` file is generated.
  sourcemap: process.env.CREATE_ARKOR_BUILD_SOURCEMAP === "1",
  tsconfig: "./tsconfig.build.json",
  // `@arkor/cli-internal` is a private workspace package — bundle its source
  // into the published tarball so consumers don't depend on something that
  // isn't on npm.
  deps: {
    alwaysBundle: ["@arkor/cli-internal"],
  },
});
