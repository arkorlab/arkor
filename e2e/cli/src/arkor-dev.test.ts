// E2E coverage for `arkor dev`'s run-to-exit paths only. The long-running
// server itself is covered by e2e/studio (Playwright spawns a real
// `arkor dev` and drives the SPA); `runCli` waits for process exit, so this
// file sticks to the flows that terminate on their own:
//
//   - the CLAUDECODE=1 strict gate (exit 1 before any server bind or HOME
//     write; the gate throws inside the Commander action, so nothing is
//     persisted and no port is opened), and
//   - `dev --help` advertising the --agent opt-in.
//
// `runCli` strips CLAUDECODE from the inherited env by default, so tests
// opt INTO strict mode via `extraEnv`, mirroring arkor-init.test.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli } from "./spawn-cli";

describe("arkor dev × CLAUDECODE strict gate (E2E)", () => {
  it("exits 1 with the --agent re-invocation block under CLAUDECODE=1 without --agent", async () => {
    const dir = makeTempDir("arkor-dev-e2e-");
    try {
      const result = await runCli(ARKOR_BIN, ["dev"], dir, {
        HOME: dir,
        CLAUDECODE: "1",
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "arkor dev: CLAUDECODE=1 detected. Interactive Studio use is disabled.",
      );
      expect(result.stderr).toContain("Re-run with the --agent flag:");
      expect(result.stderr).toContain("--agent");
      expect(result.stderr).toContain("X-Arkor-Studio-Token");
      // The gate fires before the server starts: no ready line, no token
      // file side effects under the isolated HOME.
      expect(result.stdout).not.toContain("Arkor Studio running on");
      // Assert the documented "nothing persisted" contract concretely: the
      // gate throws before runDev, so neither the home studio-token nor a
      // project agent session dir is created (a regression that moved the gate
      // after persistence would fail here). Telemetry may create ~/.arkor
      // itself, so check the specific ENG-967 artifacts, not the whole dir.
      expect(existsSync(join(dir, ".arkor", "studio-token"))).toBe(false);
      expect(existsSync(join(dir, ".arkor", "agent"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("advertises --agent in `dev --help`", async () => {
    const dir = makeTempDir("arkor-dev-help-e2e-");
    try {
      const result = await runCli(ARKOR_BIN, ["dev", "--help"], dir, {
        HOME: dir,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--agent");
      expect(result.stdout).toContain("coding agents");
    } finally {
      cleanup(dir);
    }
  });
});
