/// <reference types="node" />
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  tsconfig: "./tsconfig.build.json",
});
