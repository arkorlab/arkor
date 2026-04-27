import { describe, it, expect } from "vitest";
import {
  detectPackageManagerFrom,
  upgradeCommandFor,
} from "./upgrade-hint";

describe("detectPackageManagerFrom (user-agent first)", () => {
  it.each([
    ["pnpm/8.15.0 npm/? node/v22 darwin x64", "pnpm"],
    ["yarn/1.22.19 npm/? node/v22 linux x64", "yarn"],
    ["bun/1.1.0", "bun"],
    ["npm/10.5.0 node/v22 linux x64", "npm"],
  ] as const)("recognises %s", (ua, expected) => {
    expect(detectPackageManagerFrom({ userAgent: ua })).toBe(expected);
  });

  it("falls through when the UA product is unknown", () => {
    expect(
      detectPackageManagerFrom({
        userAgent: "deno/1.40",
        execPath: "/usr/local/lib/node_modules/arkor/dist/bin.mjs",
      }),
    ).toBe("npm");
  });
});

describe("detectPackageManagerFrom (path fallback)", () => {
  it.each([
    [
      "/home/user/.local/share/pnpm/global/5/.pnpm/arkor@1.0.0/node_modules/arkor/dist/bin.mjs",
      "pnpm",
    ],
    [
      "/home/user/.bun/install/global/node_modules/arkor/dist/bin.mjs",
      "bun",
    ],
    [
      "/home/user/.config/yarn/global/node_modules/arkor/dist/bin.mjs",
      "yarn",
    ],
    [
      "/usr/local/lib/node_modules/arkor/dist/bin.mjs",
      "npm", // default fallback
    ],
  ] as const)("classifies %s", (execPath, expected) => {
    expect(detectPackageManagerFrom({ execPath })).toBe(expected);
  });

  it("handles Windows-style separators", () => {
    expect(
      detectPackageManagerFrom({
        execPath:
          "C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\arkor\\dist\\bin.mjs",
      }),
    ).toBe("pnpm");
  });
});

describe("upgradeCommandFor", () => {
  it.each([
    ["npm", "npm install -g arkor@latest"],
    ["pnpm", "pnpm add -g arkor@latest"],
    ["yarn", "yarn global add arkor@latest"],
    ["bun", "bun add -g arkor@latest"],
  ] as const)("returns the install command for %s", (pm, expected) => {
    expect(upgradeCommandFor(pm)).toBe(expected);
  });
});
