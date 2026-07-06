import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUILD_DEFAULTS,
  resolveBuildEntry,
  resolveNodeTarget,
  rolldownInputOptions,
} from "./rolldownConfig";

describe("resolveNodeTarget", () => {
  it("stays in lockstep with the published engines.node floor", () => {
    // CodeRabbit (round 83): `resolveNodeTarget` returns a
    // hand-maintained literal, and its correctness contract is "equals
    // the `engines.node` floor in package.json". Deriving the value
    // from package.json at runtime would bake the manifest into the
    // shipped bundle just to avoid this edit; a test-time guard gives
    // the same drift protection (raising the floor without updating
    // the literal fails CI) with zero runtime cost.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const floor = /(\d+)\.(\d+)/.exec(pkg.engines?.node ?? "");
    expect(floor).not.toBeNull();
    expect(resolveNodeTarget()).toBe(`node${floor![1]}.${floor![2]}`);
  });

  it("feeds the target into the shared rolldown input options", () => {
    const resolved = resolveBuildEntry({ cwd: "/tmp/proj" });
    const opts = rolldownInputOptions(resolved);
    expect(opts.transform?.target).toBe(resolveNodeTarget());
    expect(resolved.outFile.endsWith("index.mjs")).toBe(true);
    expect(BUILD_DEFAULTS.entry).toBe("src/arkor/index.ts");
  });
});
