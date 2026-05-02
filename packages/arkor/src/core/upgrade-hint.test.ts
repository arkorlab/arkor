import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectPackageManagerFrom,
  detectedUpgradeCommand,
  formatSdkUpgradeError,
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

  it("returns the npm fallback when both userAgent and execPath are undefined", () => {
    // Vitest workers historically launched with `process.argv[1]` set to
    // a path that doesn't match any pm marker, but a future runner may
    // not even pass argv[1] (e.g. piped via stdin). The detector must
    // treat that case the same as "unknown" and fall back to npm.
    expect(detectPackageManagerFrom({})).toBe("npm");
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

describe("detectedUpgradeCommand", () => {
  const ORIG_UA = process.env.npm_config_user_agent;
  const ORIG_ARGV1 = process.argv[1];

  beforeEach(() => {
    delete process.env.npm_config_user_agent;
    // Replace argv[1] with a path no detector will recognise so the npm
    // fallback applies — otherwise the test inherits whatever vitest's
    // worker exec path looked like.
    process.argv[1] = "/usr/local/bin/arkor";
  });

  afterEach(() => {
    if (ORIG_UA === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = ORIG_UA;
    // Direct assignment of `undefined` would leave the slot as the
    // literal value `undefined` and break later callers that assume
    // `process.argv` is `string[]`. Splice the index out instead when
    // the original was missing.
    if (ORIG_ARGV1 === undefined) process.argv.splice(1, 1);
    else process.argv[1] = ORIG_ARGV1;
  });

  it("uses the detected pm when the user-agent reveals it", () => {
    process.env.npm_config_user_agent = "pnpm/10 node/v22 linux x64";
    expect(detectedUpgradeCommand()).toBe("pnpm add -g arkor@latest");
  });

  it("falls back to npm when nothing is detectable", () => {
    expect(detectedUpgradeCommand()).toBe("npm install -g arkor@latest");
  });
});

describe("formatSdkUpgradeError", () => {
  const ORIG_UA = process.env.npm_config_user_agent;
  const ORIG_ARGV1 = process.argv[1];

  beforeEach(() => {
    // Pin the detected pm so the assertions are deterministic regardless of
    // the developer's local shell. `pnpm` here matches the detection regex
    // both on path and UA.
    process.env.npm_config_user_agent = "pnpm/10 node/v22 linux x64";
    process.argv[1] = "/usr/local/bin/arkor";
  });

  afterEach(() => {
    if (ORIG_UA === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = ORIG_UA;
    // Direct assignment of `undefined` would leave the slot as the
    // literal value `undefined` and break later callers that assume
    // `process.argv` is `string[]`. Splice the index out instead when
    // the original was missing.
    if (ORIG_ARGV1 === undefined) process.argv.splice(1, 1);
    else process.argv[1] = ORIG_ARGV1;
  });

  it("returns the rich version-out-of-range message with the pm-aware command", () => {
    const msg = formatSdkUpgradeError({
      error: "sdk_version_unsupported",
      currentVersion: "1.3.5",
      supportedRange: "^1.4.0 || >=2.1.0",
      upgrade: "npm install -g arkor@latest",
    });
    expect(msg).toContain("1.3.5 is no longer supported");
    expect(msg).toContain("^1.4.0 || >=2.1.0");
    // Detected pm overrides the body's `upgrade` field.
    expect(msg).toContain("pnpm add -g arkor@latest");
    expect(msg).not.toContain("npm install -g arkor@latest");
  });

  it("returns the dedicated 'missing header' message when reason=missing", () => {
    const msg = formatSdkUpgradeError({
      error: "sdk_version_unsupported",
      currentVersion: "unknown",
      supportedRange: "*",
      upgrade: "npm install -g arkor@latest",
      reason: "missing",
    });
    expect(msg).toMatch(/X-Arkor-Client header was missing/);
  });

  it("returns the dedicated 'malformed header' message when reason=malformed", () => {
    const msg = formatSdkUpgradeError({
      error: "sdk_version_unsupported",
      currentVersion: "unknown",
      supportedRange: "*",
      upgrade: "npm install -g arkor@latest",
      reason: "malformed",
    });
    expect(msg).toMatch(/X-Arkor-Client header was malformed/);
  });

  it.each([null, undefined, "not json", { wrong: "shape" }, 42] as const)(
    "falls back to the generic message for unparseable body %p",
    (body) => {
      // When the gate's 426 body is missing / non-JSON / wrong shape, callers
      // must still surface a non-empty actionable message. Without the
      // fallback in `formatSdkUpgradeError`, the caller would see `null`
      // and likely fall through to a different (incorrect) code path.
      const msg = formatSdkUpgradeError(body);
      expect(msg).toMatch(/Arkor SDK is no longer supported/);
      expect(msg).toContain("pnpm add -g arkor@latest");
    },
  );
});
