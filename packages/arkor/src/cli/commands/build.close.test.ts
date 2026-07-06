// Separate file from `build.test.ts` on purpose: `vi.mock("rolldown")`
// is module-hoisted and would fake the bundler for every test in the
// file, but the sibling suite exercises REAL rolldown builds
// end-to-end. This suite pins the resource-lifecycle contract only:
// `runBuild` must close the rolldown bundle whether `write()`
// succeeds or throws (rolldown keeps native resources alive until
// `close()`; a failed build that skips it leaks them for the process
// lifetime, which for a long `arkor dev` session with repeated
// manifest fallback builds is real memory).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runBuild } from "./build";

const writeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const closeMock = vi.fn<() => Promise<void>>(async () => undefined);

vi.mock("rolldown", () => ({
  rolldown: vi.fn(async () => ({ write: writeMock, close: closeMock })),
}));

let cwd: string;

beforeEach(() => {
  vi.clearAllMocks();
  cwd = mkdtempSync(join(tmpdir(), "arkor-build-close-test-"));
  mkdirSync(join(cwd, "src/arkor"), { recursive: true });
  writeFileSync(join(cwd, "src/arkor/index.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runBuild bundle lifecycle (rolldown mocked)", () => {
  it("closes the bundle after a successful write", async () => {
    writeMock.mockResolvedValueOnce({});
    await runBuild({ cwd, quiet: true });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the bundle even when write() rejects, and propagates the failure", async () => {
    writeMock.mockRejectedValueOnce(new Error("ENOSPC: disk full"));
    await expect(runBuild({ cwd, quiet: true })).rejects.toThrow(
      /ENOSPC: disk full/,
    );
    // The `finally` contract under test: no close, no native-resource
    // release on the failure path.
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
