import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  install,
  lockfileChangedSince,
  nodeModulesChangedSince,
  snapshotLockfile,
  snapshotNodeModules,
  type LockfileSnapshot,
  type NodeModulesSnapshot,
} from "./install";

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
  //
  // Round 39 (Codex P2): also dump lowercase + mixed-case variants
  // of YARN_ENABLE_IMMUTABLE_INSTALLS so the case-insensitive
  // strip in install.ts can be exercised on POSIX (env vars are
  // case-sensitive there, but the loop deletes any matching
  // variant regardless).
  writeFileSync(
    path,
    `#!/usr/bin/env sh\necho "fake $@" >> "${marker}"\n` +
      `printenv ADBLOCK >> "${marker}"\nprintenv NODE_ENV >> "${marker}"\n` +
      `printenv YARN_ENABLE_IMMUTABLE_INSTALLS >> "${marker}"\n` +
      `printenv yarn_enable_immutable_installs >> "${marker}"\n` +
      `printenv Yarn_Enable_Immutable_Installs >> "${marker}"\n` +
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

      const fs = await import("node:fs");
      const log = fs.readFileSync(marker, "utf8");
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

  // Round 39 (Codex P2, PR #99): on Windows, env-var lookup is
  // case-insensitive — `YARN_ENABLE_IMMUTABLE_INSTALLS` and
  // `yarn_enable_immutable_installs` are the same variable to
  // the OS, and Node passes through whatever casing the parent
  // shell used. A case-exact `delete env.YARN_ENABLE_IMMUTABLE_INSTALLS`
  // would miss a `yarn_enable_immutable_installs=false` leaking in
  // through `{ ...process.env }`, so install.ts loops every key
  // and deletes any case-insensitive match. POSIX env vars are
  // case-sensitive so we can simulate the leak by exporting the
  // lowercase variant directly — if the strip is correct, the
  // child's `printenv yarn_enable_immutable_installs` returns
  // empty when an enclosing yarn.lock is present.
  onPosix(
    "strips lowercase / mixed-case variants of YARN_ENABLE_IMMUTABLE_INSTALLS from the child env when yarn.lock exists",
    async () => {
      writeFileSync(join(cwd, "yarn.lock"), "# pre-existing\n");
      const ORIG_LOWER = process.env.yarn_enable_immutable_installs;
      const ORIG_MIXED = process.env.Yarn_Enable_Immutable_Installs;
      process.env.yarn_enable_immutable_installs = "false";
      process.env.Yarn_Enable_Immutable_Installs = "false";
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("yarn", 0, marker);

        await install("yarn", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // None of the case variants survived to the child.
        expect(log).not.toContain("\nfalse\n");
      } finally {
        if (ORIG_LOWER === undefined) delete process.env.yarn_enable_immutable_installs;
        else process.env.yarn_enable_immutable_installs = ORIG_LOWER;
        if (ORIG_MIXED === undefined) delete process.env.Yarn_Enable_Immutable_Installs;
        else process.env.Yarn_Enable_Immutable_Installs = ORIG_MIXED;
      }
    },
  );

  // Round 40 follow-up (Copilot, PR #99): renamed from the
  // earlier "does NOT forward..." framing because that overstated
  // the contract. `install()` only manages
  // `YARN_ENABLE_IMMUTABLE_INSTALLS` in the yarn branch; for
  // non-yarn pms it forwards `process.env` unchanged. What this
  // test really pins down is the BASELINE: with a clean env (no
  // inherited variant), the non-yarn spawn doesn't introduce the
  // variable on its own. We delete every case-insensitive
  // variant up-front so the assertion describes the
  // implementation behaviour rather than the developer's shell
  // hygiene.
  onPosix(
    "does not synthesise YARN_ENABLE_IMMUTABLE_INSTALLS for non-yarn pms when the parent env doesn't set it",
    async () => {
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === "YARN_ENABLE_IMMUTABLE_INSTALLS") {
          saved[key] = process.env[key];
          delete process.env[key];
        }
      }
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("pnpm", 0, marker);

        await install("pnpm", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // The fake pm dumps `printenv YARN_ENABLE_IMMUTABLE_INSTALLS`,
        // which prints an empty line when the variable is absent.
        // No `\nfalse\n` or `\ntrue\n` means install() didn't
        // introduce the variable.
        expect(log).not.toContain("\nfalse\n");
        expect(log).not.toContain("\ntrue\n");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
    },
  );

  // Companion: when the parent env DOES set the variable,
  // `install()` forwards it unchanged for non-yarn pms (no strip,
  // no override). This pins down the round-40 contract that the
  // yarn-specific normalization is yarn-only.
  onPosix(
    "FORWARDS an inherited YARN_ENABLE_IMMUTABLE_INSTALLS verbatim for non-yarn pms",
    async () => {
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === "YARN_ENABLE_IMMUTABLE_INSTALLS") {
          saved[key] = process.env[key];
          delete process.env[key];
        }
      }
      process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("pnpm", 0, marker);

        await install("pnpm", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // The variable leaked through to the non-yarn spawn —
        // that's fine, pnpm ignores it. The contract: install()
        // does NOT strip non-yarn env, only yarn env.
        expect(log).toContain("\nfalse\n");
      } finally {
        // Delete the test-injected canonical value FIRST so the
        // restore loop below doesn't get clobbered by a later
        // delete (which would drop an original canonical value
        // the dev/CI shell had set). Round-40 (Copilot, PR #99)
        // flagged this ordering bug.
        delete process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
    },
  );

  // Round 40 (Copilot, PR #99): preserving an explicit
  // `YARN_ENABLE_IMMUTABLE_INSTALLS=true` in the existing-
  // lockfile branch is what protects a user who deliberately
  // opted into immutable installs in a non-CI shell (where
  // yarn's default is `false`). The previous round's broader
  // strip removed even truthy values; the `isYarnTruthy` gate
  // now preserves `true` / `1` / `yes` / etc. Lock that down so
  // a future env-normalization refactor doesn't accidentally
  // strip the user's opt-in.
  onPosix(
    "PRESERVES a user-set YARN_ENABLE_IMMUTABLE_INSTALLS=true when yarn.lock exists",
    async () => {
      writeFileSync(join(cwd, "yarn.lock"), "# pre-existing\n");
      const ORIG = process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
      // Save + strip every case-variant first so the test
      // asserts the implementation, not the shell's hygiene.
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === "YARN_ENABLE_IMMUTABLE_INSTALLS") {
          saved[key] = process.env[key];
          delete process.env[key];
        }
      }
      process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "true";
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("yarn", 0, marker);

        await install("yarn", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // The child sees the truthy value, NOT the strip.
        expect(log).toContain("\ntrue\n");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
        if (ORIG === undefined) {
          delete process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
        } else {
          process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = ORIG;
        }
      }
    },
  );

  // Counterpart: even with a `yarn.lock` present, an EXPLICIT
  // `=false` from the parent still gets stripped (round-32 anti-
  // leak invariant). The asymmetry — preserve truthy, strip
  // falsy — is what addresses both Copilot reviews (round-32:
  // anti-leak; round-40: don't override user's immutable opt-in).
  onPosix(
    "still STRIPS YARN_ENABLE_IMMUTABLE_INSTALLS=false when yarn.lock exists (round-32 anti-leak)",
    async () => {
      writeFileSync(join(cwd, "yarn.lock"), "# pre-existing\n");
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === "YARN_ENABLE_IMMUTABLE_INSTALLS") {
          saved[key] = process.env[key];
          delete process.env[key];
        }
      }
      process.env.YARN_ENABLE_IMMUTABLE_INSTALLS = "false";
      try {
        const marker = join(cwd, "marker.log");
        makeFakePm("yarn", 0, marker);

        await install("yarn", cwd);

        const log = (await import("node:fs")).readFileSync(marker, "utf8");
        // The `=false` did NOT survive — yarn falls back to its
        // CI default (immutable=true), protecting the lockfile.
        expect(log).not.toContain("\nfalse\n");
      } finally {
        // Delete-then-restore order matters: see the "FORWARDS"
        // test's finally for the rationale (round 40 Copilot,
        // PR #99 — deleting after restore drops any original
        // canonical value the dev/CI shell had set).
        delete process.env.YARN_ENABLE_IMMUTABLE_INSTALLS;
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
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

// Round 39 (Copilot, PR #99): pnpm 11 / bun on Windows can exit
// non-zero AFTER writing the lockfile, so the CLI's git-init gate
// needs an on-disk fallback to recognise the "install threw but
// the bootstrap is effectively complete" case. The pre-install
// snapshot + post-install change check is what closes the round-39-
// follow-up Codex P1 hazard: a workspace-subdir scaffold has a
// stale ancestor lockfile, so a bare existence check would treat
// a totally failed install as "lockfile landed". Forward-moving
// mtime is the proof we need.
describe("snapshotLockfile + lockfileChangedSince", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lockfile-landed-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshotLockfile returns no-existence when pm is undefined", () => {
    expect(snapshotLockfile(dir, undefined)).toEqual({
      exists: false,
      path: null,
      mtimeMs: 0,
    });
  });

  it.each([
    { pm: "npm" as const, file: "package-lock.json" },
    { pm: "pnpm" as const, file: "pnpm-lock.yaml" },
    { pm: "yarn" as const, file: "yarn.lock" },
    { pm: "bun" as const, file: "bun.lock" },
  ])(
    "snapshotLockfile records existence + mtime for $pm's $file when present",
    ({ pm, file }) => {
      // Note: `snapshotLockfile` walks ancestors, so a pre-write
      // `exists === false` guard would be flaky if an ambient
      // lockfile sits in `/tmp/` or above. Instead, after writing
      // the fixture's lockfile, assert the resolved path equals
      // the file we just wrote — that proves the walk found
      // OUR lockfile, regardless of ambient state above.
      writeFileSync(join(dir, file), "");
      const snap = snapshotLockfile(dir, pm);
      expect(snap.exists).toBe(true);
      expect(snap.path).toBe(join(dir, file));
      expect(snap.mtimeMs).toBeGreaterThan(0);
    },
  );

  it("snapshotLockfile does not match a different pm's lockfile (e.g. yarn.lock when pm=npm) inside the fixture", () => {
    writeFileSync(join(dir, "yarn.lock"), "");
    // The yarn assertion verifies the fixture-owned file is found.
    const yarnSnap = snapshotLockfile(dir, "yarn");
    expect(yarnSnap.exists).toBe(true);
    expect(yarnSnap.path).toBe(join(dir, "yarn.lock"));
    // For npm, the fixture has no `package-lock.json`, but an
    // ambient ancestor (e.g. `/tmp/package-lock.json`) might.
    // Assert that — if anything is found — it's NOT the fixture's
    // file. The contract under test is "this fixture's yarn.lock
    // doesn't satisfy the npm lookup", which holds regardless of
    // ambient state.
    const npmSnap = snapshotLockfile(dir, "npm");
    if (npmSnap.exists) {
      expect(npmSnap.path).not.toBe(join(dir, "yarn.lock"));
      expect(npmSnap.path).not.toBe(join(dir, "package-lock.json"));
    }
  });

  // Round 39 (Copilot, PR #99): when the scaffold target is a
  // workspace subdir (`monorepo/packages/foo`), every supported
  // pm hoists the lockfile to the workspace root. A cwd-only
  // check would miss the recovered-install signal and skip the
  // requested git init even though the install effectively
  // succeeded. `snapshotLockfile` walks ancestors via the same
  // `dirname() === self` termination as `hasEnclosingYarnLock`.
  it.each([
    { pm: "npm" as const, file: "package-lock.json" },
    { pm: "pnpm" as const, file: "pnpm-lock.yaml" },
    { pm: "yarn" as const, file: "yarn.lock" },
    { pm: "bun" as const, file: "bun.lock" },
  ])(
    "snapshotLockfile finds $pm's $file in an ancestor (workspace-subdir scaffold)",
    ({ pm, file }) => {
      const sub = join(dir, "packages", "foo");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(dir, file), "");
      expect(snapshotLockfile(sub, pm).exists).toBe(true);
    },
  );

  // Round 39 follow-up (Codex P1): existence alone isn't enough.
  // A stale ancestor lockfile present BEFORE install and unchanged
  // AFTER must NOT be treated as "install landed", or a workspace-
  // subdir scaffold with a totally failed install would slip the
  // git-init gate. Forward-moving mtime is the only positive
  // signal; equal mtime + same existence is "nothing changed".
  it("lockfileChangedSince returns false when the lockfile pre-existed and was untouched", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const before: LockfileSnapshot = snapshotLockfile(dir, "pnpm");
    expect(lockfileChangedSince(dir, "pnpm", before)).toBe(false);
  });

  it("lockfileChangedSince returns true when a fixture-owned lockfile is newly created", () => {
    // The `snapshotLockfile` walk may resolve to an ambient
    // ancestor lockfile (e.g. `/tmp/pnpm-lock.yaml`), so we
    // can't assert `before.exists === false` directly. Instead,
    // capture the BEFORE state — whatever it found — and verify
    // the AFTER state reports a forward-moving change once we
    // write a CLOSER lockfile under the fixture.
    const before: LockfileSnapshot = snapshotLockfile(dir, "pnpm");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const after: LockfileSnapshot = snapshotLockfile(dir, "pnpm");
    expect(after.path).toBe(join(dir, "pnpm-lock.yaml"));
    // EITHER the BEFORE snap saw nothing (clean ancestor chain,
    // appearance counts) OR it resolved to a farther ancestor
    // (closer one now wins — path change counts).
    expect(lockfileChangedSince(dir, "pnpm", before)).toBe(true);
  });

  it("lockfileChangedSince returns true when the lockfile mtime advances", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "v1\n");
    const before: LockfileSnapshot = snapshotLockfile(dir, "pnpm");
    // Advance the file's mtime explicitly — `writeFileSync` on the
    // same path within the same millisecond can leave mtime
    // unchanged on coarse-resolution filesystems, which would mask
    // the assertion. Using `utimesSync` is deterministic.
    const newer = (before.mtimeMs + 5_000) / 1000;
    utimesSync(join(dir, "pnpm-lock.yaml"), newer, newer);
    expect(lockfileChangedSince(dir, "pnpm", before)).toBe(true);
  });

  // Round 40 (Copilot, PR #99): the resolved-path tracking lets
  // the diff catch a topology mtime alone misses. When the
  // BEFORE snapshot resolved an ancestor lockfile but install
  // creates a CLOSER cwd-local one, the two paths are different
  // files; an mtime comparison between them is meaningless (the
  // new lockfile can plausibly have an older mtime than the
  // ancestor's on second-resolution filesystems or under clock
  // skew). Path change = material change.
  it("lockfileChangedSince returns true when install creates a closer lockfile under cwd", () => {
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    // BEFORE: only the ancestor (monorepo root) has a lockfile.
    // Make its mtime artificially HIGH so a naive mtime-only
    // comparison would fail to detect the new closer one if its
    // mtime happens to be lower.
    writeFileSync(join(dir, "pnpm-lock.yaml"), "ancestor\n");
    const farFuture = (Date.now() + 60_000) / 1000;
    utimesSync(join(dir, "pnpm-lock.yaml"), farFuture, farFuture);
    const before: LockfileSnapshot = snapshotLockfile(sub, "pnpm");
    expect(before.path).toBe(join(dir, "pnpm-lock.yaml"));
    // AFTER: install creates a cwd-local lockfile. The closer
    // one now wins the walk, so `after.path` differs from
    // `before.path` — that's the install-touched-something
    // signal even though `after.mtimeMs < before.mtimeMs`.
    writeFileSync(join(sub, "pnpm-lock.yaml"), "local\n");
    expect(lockfileChangedSince(sub, "pnpm", before)).toBe(true);
  });
});

// Round 40 follow-up (Codex P2 cluster, PR #99): the install-
// recovery gate pairs `lockfileChangedSince` with a
// `node_modules` BEFORE/AFTER diff that has to handle FOUR
// install topologies:
//   1. Standalone scaffold       → cwd/node_modules appears.
//   2. Monorepo subdir + local   → cwd/node_modules appears.
//   3. Monorepo subdir + hoisted (pre-existing ancestor)
//      → captured ancestor node_modules mtime advances.
//   4. Monorepo subdir + hoisted (NO ancestor before install)
//      → ancestor node_modules newly appears (e.g. yarn-berry
//        `node-modules` linker on a fresh workspace, or a
//        closer ancestor materialized while a farther one
//        already existed).
// The earlier round-39 #3 design tracked just the closest-
// enclosing path captured BEFORE install, so it missed cases
// (4) — Codex P2 (round 40) flagged three flavours of that
// false-negative. The current design records the FULL chain of
// existing ancestor `node_modules` paths in a Map, then
// re-walks AFTER install: any new path OR forward-moving mtime
// on a known path returns true.
describe("snapshotNodeModules + nodeModulesChangedSince", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "node-modules-snapshot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshotNodeModules records cwd-no-existence; enclosing chain may contain ambient ancestors", () => {
    // The `snapshot` walk goes all the way to the filesystem
    // root, so `enclosing.size` can be non-zero if any ancestor
    // (e.g. a developer's `/tmp/node_modules`) is on disk. The
    // assertion under test is the cwd slot — the fixture has no
    // local `node_modules` until we create one.
    const snap = snapshotNodeModules(dir);
    expect(snap.cwd).toEqual({ exists: false, mtimeMs: 0 });
    // The fixture's own future `node_modules` path is not yet
    // in the chain (it doesn't exist yet).
    expect(snap.enclosing.has(join(dir, "node_modules"))).toBe(false);
  });

  it("snapshotNodeModules records existence + mtime when cwd has node_modules", () => {
    mkdirSync(join(dir, "node_modules"));
    const snap = snapshotNodeModules(dir);
    expect(snap.cwd.exists).toBe(true);
    expect(snap.cwd.mtimeMs).toBeGreaterThan(0);
  });

  it("snapshotNodeModules captures enclosing node_modules above cwd", () => {
    // Monorepo-subdir shape: cwd has no local node_modules,
    // but a parent does. The enclosing Map records the parent
    // path so a hoisted install that updates it is detected.
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    const snap = snapshotNodeModules(sub);
    expect(snap.cwd.exists).toBe(false);
    expect(snap.enclosing.has(join(dir, "node_modules"))).toBe(true);
    expect(snap.enclosing.get(join(dir, "node_modules"))).toBeGreaterThan(0);
  });

  it("snapshotNodeModules excludes cwd's own node_modules from the enclosing chain", () => {
    // The enclosing slot is meant strictly for ancestors. If
    // cwd's own node_modules leaked in, a successful install
    // would double-count and the diff would lose meaning.
    mkdirSync(join(dir, "node_modules"));
    const snap = snapshotNodeModules(dir);
    expect(snap.cwd.exists).toBe(true);
    expect(snap.enclosing.has(join(dir, "node_modules"))).toBe(false);
  });

  it("nodeModulesChangedSince returns false when nothing changed", () => {
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    expect(nodeModulesChangedSince(dir, before)).toBe(false);
  });

  it("nodeModulesChangedSince returns true when cwd node_modules is newly created", () => {
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    expect(before.cwd.exists).toBe(false);
    mkdirSync(join(dir, "node_modules"));
    expect(nodeModulesChangedSince(dir, before)).toBe(true);
  });

  it("nodeModulesChangedSince returns true when cwd node_modules mtime advances", () => {
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    const newer = (before.cwd.mtimeMs + 5_000) / 1000;
    utimesSync(join(dir, "node_modules"), newer, newer);
    expect(nodeModulesChangedSince(dir, before)).toBe(true);
  });

  // Topology #3: pre-existing ancestor + hoisted install.
  it("nodeModulesChangedSince returns true when a captured ancestor node_modules mtime advances (hoisted install)", () => {
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(sub);
    expect(before.cwd.exists).toBe(false);
    const beforeMtime = before.enclosing.get(join(dir, "node_modules"))!;
    const newer = (beforeMtime + 5_000) / 1000;
    utimesSync(join(dir, "node_modules"), newer, newer);
    expect(nodeModulesChangedSince(sub, before)).toBe(true);
  });

  // Topology #4a (Codex P2, round 40): a NEW closer ancestor
  // appears during install. Previously regressed by the round-39
  // #3 design that pinned to a single captured path —
  // `before.enclosing.path === null` short-circuited the probe
  // entirely. The fixture demonstrates the closer-ancestor case
  // by creating `dir/node_modules` AFTER snapshotting from
  // `dir/packages/foo`. The snapshot's enclosing chain may also
  // contain unrelated ambient ancestors (the walk reaches the
  // filesystem root); we only assert behaviour about paths
  // INSIDE the fixture.
  it("nodeModulesChangedSince returns true when a closer fixture-local ancestor node_modules newly appears", () => {
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    const before: NodeModulesSnapshot = snapshotNodeModules(sub);
    expect(before.cwd.exists).toBe(false);
    // The fixture's `dir/node_modules` doesn't exist yet at
    // snapshot time, so it's NOT in the BEFORE enclosing chain.
    expect(before.enclosing.has(join(dir, "node_modules"))).toBe(false);
    // Hoisted install creates the ancestor for the first time.
    mkdirSync(join(dir, "node_modules"));
    expect(nodeModulesChangedSince(sub, before)).toBe(true);
  });

  // Topology #4b (Codex P2, round 40): a far ancestor existed
  // before install, but install creates a CLOSER ancestor.
  // Round-39 #3 missed this because the captured path only
  // pointed at the far one, which stays unchanged.
  it("nodeModulesChangedSince returns true when a closer ancestor node_modules appears even if a far one was captured", () => {
    const mid = join(dir, "monorepo");
    const sub = join(mid, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules")); // far ancestor exists pre-install
    const before: NodeModulesSnapshot = snapshotNodeModules(sub);
    expect(before.enclosing.has(join(dir, "node_modules"))).toBe(true);
    expect(before.enclosing.has(join(mid, "node_modules"))).toBe(false);
    // Install hoists into the closer ancestor (mid), creating
    // it for the first time. The far ancestor is untouched.
    mkdirSync(join(mid, "node_modules"));
    expect(nodeModulesChangedSince(sub, before)).toBe(true);
  });

  // The round-39 P1 hazard regression: a pre-existing parent
  // `node_modules` that DOESN'T change during a failed install
  // must NOT pass the gate. The Map records its mtime; the
  // re-walk finds the same path with the same mtime; diff
  // returns false even though the directory exists.
  it("nodeModulesChangedSince ignores static enclosing node_modules untouched by install", () => {
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(sub);
    // Don't touch the parent's node_modules — simulate a
    // failed install that never wrote to disk.
    expect(nodeModulesChangedSince(sub, before)).toBe(false);
  });
});
