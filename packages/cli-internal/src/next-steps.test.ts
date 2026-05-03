import { describe, expect, it } from "vitest";
import {
  MANUAL_DEV_HINT,
  MANUAL_INSTALL_HINT,
  MANUAL_RUN_ARKOR_DEV_HINT,
  runArkorDevViaPm,
} from "./next-steps";
import type { PackageManager } from "./package-manager";

describe("runArkorDevViaPm", () => {
  it.each<{ pm: PackageManager; expected: string }>([
    { pm: "npm", expected: "npx arkor dev" },
    { pm: "pnpm", expected: "pnpm exec arkor dev" },
    { pm: "yarn", expected: "yarn run arkor dev" },
    { pm: "bun", expected: "bunx arkor dev" },
  ])("returns the runner form for $pm", ({ pm, expected }) => {
    expect(runArkorDevViaPm(pm)).toBe(expected);
  });

  it("throws on an unknown package manager (defends against PackageManager union drift)", () => {
    // Cast through `unknown` so the test exercises the runtime `assertNever`
    // path without TypeScript rejecting it at compile time.
    expect(() =>
      runArkorDevViaPm("rush" as unknown as PackageManager),
    ).toThrow(/Unhandled package manager: rush/);
  });
});

describe("manual hint constants", () => {
  // Spot-check the exact wording so a typo here surfaces in CI rather than in
  // a freshly scaffolded project's outro.
  it("MANUAL_INSTALL_HINT lists every supported package manager", () => {
    expect(MANUAL_INSTALL_HINT).toContain("npm i");
    expect(MANUAL_INSTALL_HINT).toContain("pnpm install");
    expect(MANUAL_INSTALL_HINT).toContain("yarn");
    expect(MANUAL_INSTALL_HINT).toContain("bun install");
  });

  it("MANUAL_DEV_HINT lists every supported package manager's dev script", () => {
    expect(MANUAL_DEV_HINT).toContain("npm run dev");
    expect(MANUAL_DEV_HINT).toContain("pnpm dev");
    expect(MANUAL_DEV_HINT).toContain("yarn dev");
    expect(MANUAL_DEV_HINT).toContain("bun dev");
  });

  it("MANUAL_RUN_ARKOR_DEV_HINT lists every runner form `arkor dev`", () => {
    expect(MANUAL_RUN_ARKOR_DEV_HINT).toContain("npx arkor dev");
    expect(MANUAL_RUN_ARKOR_DEV_HINT).toContain("pnpm exec arkor dev");
    expect(MANUAL_RUN_ARKOR_DEV_HINT).toContain("yarn run arkor dev");
    expect(MANUAL_RUN_ARKOR_DEV_HINT).toContain("bunx arkor dev");
  });
});
