import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install } from "./install";

let cwd: string;
let fakeBin: string;
const ORIG_PATH = process.env.PATH;

// Spawn a real subprocess that's actually a tiny shell script masquerading
// as the requested package manager. We then assert on the recorder's log
// the helper exec'd it correctly. This is closer to how install() runs in
// production than mocking spawn would be.
function makeFakePm(name: string, exitCode: number, marker: string): string {
  const path = join(fakeBin, name);
  writeFileSync(
    path,
    `#!/usr/bin/env sh\nset -e\necho "fake $@" >> "${marker}"\n` +
      `printenv ADBLOCK >> "${marker}"\nprintenv NODE_ENV >> "${marker}"\n` +
      `printenv YARN_ENABLE_IMMUTABLE_INSTALLS >> "${marker}"\n` +
      `exit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return path;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-internal-install-test-"));
  fakeBin = mkdtempSync(join(tmpdir(), "cli-internal-install-bin-"));
  // Prepend the fake-bin dir so spawn("npm"…) resolves to our shim.
  // Use `ORIG_PATH ?? ""` (not `process.env.PATH`) so a `beforeEach` that
  // runs after a previously-overwritten test still sees the original
  // PATH, not the shim from a sibling test.
  process.env.PATH = `${fakeBin}${delimiter}${ORIG_PATH ?? ""}`;
});

afterEach(() => {
  // Node coerces `process.env.X = undefined` to the literal string
  // "undefined", so a plain assignment would pollute later tests when
  // PATH was originally unset. Delete-on-undefined mirrors the env-var
  // restore pattern used elsewhere in the test suite.
  if (ORIG_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIG_PATH;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

describe("install", () => {
  // Skip on Windows: the shell shim above relies on POSIX semantics, and
  // the helper itself goes through `shell: true` there which makes the
  // PATH override race against shell builtins.
  const onPosix = process.platform !== "win32" ? it : it.skip;

  onPosix(
    "spawns `<pm> install` in cwd with ADBLOCK + NODE_ENV=development + YARN_ENABLE_IMMUTABLE_INSTALLS=false",
    async () => {
      const marker = join(cwd, "marker.log");
      makeFakePm("npm", 0, marker);

      await install("npm", cwd);

      const log = (await import("node:fs")).readFileSync(marker, "utf8");
      // First line: the args we passed.
      expect(log).toContain("fake install");
      // Env was forwarded to the child — these are the flags that matter
      // for production behaviour:
      //   - ADBLOCK silences create-* promo output (= "1")
      //   - NODE_ENV stops pnpm dropping devDependencies (= "development")
      //   - YARN_ENABLE_IMMUTABLE_INSTALLS=false unblocks yarn 4's first
      //     install of a fresh scaffold under CI=1 (round-13 review):
      //     yarn berry refuses to write the missing yarn.lock under
      //     immutable mode and the user-facing `arkor init --use-yarn`
      //     would fail without this. Forwarded for every pm so the env
      //     contract is uniform; non-yarn pms ignore the variable.
      expect(log).toContain("\n1\n");
      expect(log).toContain("\ndevelopment\n");
      expect(log).toContain("\nfalse\n");
    },
  );

  onPosix("rejects with the exit code when the pm exits non-zero", async () => {
    const marker = join(cwd, "marker.log");
    makeFakePm("pnpm", 7, marker);

    await expect(install("pnpm", cwd)).rejects.toThrow(
      /pnpm install.*exited with code 7/,
    );
  });

  it("rejects when the pm binary cannot be spawned at all", async () => {
    // Point spawn at a name that definitely doesn't exist on PATH so the
    // helper hits its `error` event branch (separate from the close-code
    // branch above).
    process.env.PATH = "/nonexistent-bin-path";
    await expect(
      install("pnpm" as never, cwd),
    ).rejects.toThrow();
  });
});
