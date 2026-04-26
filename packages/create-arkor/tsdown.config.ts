import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  tsconfig: "./tsconfig.build.json",
  // `@arkor/cli-internal` is a private workspace package — bundle its source
  // into the published tarball so consumers don't depend on something that
  // isn't on npm.
  deps: {
    alwaysBundle: ["@arkor/cli-internal"],
  },
});
