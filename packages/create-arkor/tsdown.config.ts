import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  tsconfig: "./tsconfig.build.json",
});
