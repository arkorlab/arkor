import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // No `set -e`: `printenv VAR` returns 1 when VAR is unset, and the
  // round-17 split made YARN_ENABLE_IMMUTABLE_INSTALLS conditional —
  // the shim must tolerate the absent case without aborting before
  // the trailing `exit ${exitCode}` runs.
  writeFileSync(
    path,
    `#!/usr/bin/env sh\necho "fake $@" >> "${marker}"\n` +
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
    "spawns `<pm> install` in cwd with ADBLOCK + NODE_ENV=development",
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
      expect(log).toContain("\n1\n");
      expect(log).toContain("\ndevelopment\n");
    },
  );

  // YARN_ENABLE_IMMUTABLE_INSTALLS gating splits along yarn-only +
  // no-pre-existing-lockfile (PR #99 round 17 — Copilot flagged that
  // an unconditional override would let `arkor init` rewrite a
  // committed lockfile in an existing yarn-berry workspace).
  onPosix(
    "forwards YARN_ENABLE_IMMUTABLE_INSTALLS=false for yarn when no pre-existing yarn.lock",
    async () => {
      const marker = join(cwd, "marker.log");
      makeFakePm("yarn", 0, marker);

      await install("yarn", cwd);

      const log = (await import("node:fs")).readFileSync(marker, "utf8");
      // The fresh-scaffold case: yarn 4's CI=1 default would otherwise
      // refuse to write the missing yarn.lock and exit YN0028. The env
      // override unblocks that without affecting yarn 1 / npm / pnpm /
      // bun (they ignore the variable).
      expect(log).toContain("\nfalse\n");
    },
  );

  onPosix(
    "does NOT forward YARN_ENABLE_IMMUTABLE_INSTALLS when a yarn.lock already exists in cwd",
    async () => {
      const marker = join(cwd, "marker.log");
      makeFakePm("yarn", 0, marker);
      // Pre-seed a lockfile to simulate an existing yarn-berry workspace
      // we're being merged into. Bypassing immutability here would let
      // the install silently rewrite the committed lockfile — exactly
      // the round-17 hazard we're guarding against.
      writeFileSync(join(cwd, "yarn.lock"), "# pre-existing\n");

      await install("yarn", cwd);

      const log = (await import("node:fs")).readFileSync(marker, "utf8");
      // The override env var is absent, so `printenv` writes the empty
      // string. Surrounding sentinel lines confirm the script ran;
      // we just want to be sure "false" doesn't appear on the
      // YARN_ENABLE_IMMUTABLE_INSTALLS line — match the empty value
      // explicitly via the line shape.
      expect(log).not.toContain("\nfalse\n");
    },
  );

  // Round 27 (Copilot, PR #99): yarn-berry workspace subdirs share
  // the root's lockfile — `yarn install` from the subdir writes to
  // the ancestor lockfile, so the cwd-only round-17 check would
  // miss this case and bypass immutable installs in the workspace
  // subdir scaffold flow. The check now walks up the ancestor tree.
  onPosix(
    "does NOT forward YARN_ENABLE_IMMUTABLE_INSTALLS when a yarn.lock exists in a parent directory",
    async () => {
      // Build a workspace-subdir layout: cwd's parent has a
      // yarn.lock, cwd itself doesn't.
      const subdir = join(cwd, "packages", "foo");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(cwd, "yarn.lock"), "# enclosing workspace lockfile\n");
      const marker = join(subdir, "marker.log");
      makeFakePm("yarn", 0, marker);

      await install("yarn", subdir);

      const log = (await import("node:fs")).readFileSync(marker, "utf8");
      // The walk-up finds the ancestor `yarn.lock` and refuses to
      // disable immutability — yarn 4 will then refuse to rewrite
      // the committed root lockfile in CI mode (correct behaviour).
      expect(log).not.toContain("\nfalse\n");
    },
  );

  // Round 32 (Copilot, PR #99): the lockfile-present branch
  // must explicitly clear `YARN_ENABLE_IMMUTABLE_INSTALLS` so a
  // parent shell that already exported `=false` (CI workflows
  // that set it globally, or a developer who set it for some
  // other workflow) doesn't leak through `{ ...process.env, ...}`
  // and bypass the very immutability check the lockfile-present
  // branch is supposed to preserve.
  onPosix(
    "explicitly clears a leaked YARN_ENABLE_IMMUTABLE_INSTALLS=false from the parent shell when yarn.lock exists",
    async () => {
      // Pre-existing lockfile in cwd.
      writeFileSync(join(cwd, "yarn.lock"), "# pre-existing\n");
      // Simulate a parent shell that exported the override
      // globally — install() would otherwise inherit this
      // through the wholesale `process.env` spread.
      const ORIG = process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
      process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("yarn", 0, marker);

        await install("yarn", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // The variable is explicitly deleted in the lockfile-
        // present branch, so `printenv` writes the empty
        // string — yarn 4 sees no override and falls back to
        // its CI=1 default of `enableImmutableInstalls=true`,
        // which is exactly what protects the committed
        // lockfile.
        expect(log).not.toContain("\nfalse\n");
      } finally {
        if (ORIG === undefined) delete process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
        else process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = ORIG;
      }
    },
  );

  onPosix(
    "does NOT forward YARN_ENABLE_IMMUTABLE_INSTALLS for non-yarn package managers",
    async () => {
      // The variable is yarn-berry-specific. Setting it for npm/pnpm/bun
      // is harmless (they ignore it) but we keep the env surface tight
      // to make the contract obvious in install.ts.
      const marker = join(cwd, "marker.log");
      makeFakePm("pnpm", 0, marker);

      await install("pnpm", cwd);

      const log = (await import("node:fs")).readFileSync(marker, "utf8");
      expect(log).not.toContain("\nfalse\n");
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
