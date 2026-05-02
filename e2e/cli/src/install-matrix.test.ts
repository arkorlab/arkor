import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_PM = process.env.ARKOR_E2E_PM;
const ORIG_SKIP = process.env.SKIP_E2E_INSTALL;

beforeEach(() => {
  delete process.env.ARKOR_E2E_PM;
  delete process.env.SKIP_E2E_INSTALL;
});

afterEach(() => {
  // Restore via the delete-when-undefined dance — `process.env.X =
  // undefined` writes the literal string "undefined" otherwise.
  if (ORIG_PM === undefined) delete process.env.ARKOR_E2E_PM;
  else process.env.ARKOR_E2E_PM = ORIG_PM;
  if (ORIG_SKIP === undefined) delete process.env.SKIP_E2E_INSTALL;
  else process.env.SKIP_E2E_INSTALL = ORIG_SKIP;
  vi.resetModules();
});

// `install-matrix.ts` snapshots ARKOR_E2E_PM / SKIP_E2E_INSTALL at
// module-eval time. `vi.resetModules()` between imports gives each
// test a fresh module-level read of `process.env` — without it the
// snapshot from the very first import would leak across tests and
// only the env mutation that ran before that first load would
// register.
async function loadMatrix() {
  vi.resetModules();
  return await import("./install-matrix");
}

describe("shouldSkipInstallCase", () => {
  it("skips everything when SKIP_E2E_INSTALL=1, regardless of ARKOR_E2E_PM", async () => {
    process.env.SKIP_E2E_INSTALL = "1";
    process.env.ARKOR_E2E_PM = "pnpm";
    const { INSTALL_CASES, shouldSkipInstallCase } = await loadMatrix();
    for (const c of INSTALL_CASES) {
      expect(shouldSkipInstallCase(c.label)).toBe(true);
    }
  });

  it("runs only the matching label when ARKOR_E2E_PM is set", async () => {
    process.env.ARKOR_E2E_PM = "yarn-berry";
    const { INSTALL_CASES, shouldSkipInstallCase } = await loadMatrix();
    for (const c of INSTALL_CASES) {
      const expected = c.label !== "yarn-berry";
      expect(shouldSkipInstallCase(c.label)).toBe(expected);
    }
  });

  it("runs only `localDefault` cases when ARKOR_E2E_PM is unset", async () => {
    const { INSTALL_CASES, shouldSkipInstallCase } = await loadMatrix();
    for (const c of INSTALL_CASES) {
      // localDefault → run (skip = false); !localDefault → skip.
      expect(shouldSkipInstallCase(c.label)).toBe(!c.localDefault);
    }
  });

  // Regression for Copilot's PR #99 review: a typo or CI-yaml drift
  // on ARKOR_E2E_PM used to make every case answer `true`, silently
  // turning the install-matrix into a false green. The function now
  // throws a loud error that names the bad label and points at the
  // CI-yaml mapping that probably drifted.
  it("throws when ARKOR_E2E_PM is set to an unknown label (no silent green)", async () => {
    process.env.ARKOR_E2E_PM = "deno";
    const { shouldSkipInstallCase } = await loadMatrix();
    expect(() => shouldSkipInstallCase("npm")).toThrow(/ARKOR_E2E_PM="deno"/);
    expect(() => shouldSkipInstallCase("npm")).toThrow(
      /PM_LABEL mapping in \.github\/workflows\/ci\.yaml/,
    );
  });
});
