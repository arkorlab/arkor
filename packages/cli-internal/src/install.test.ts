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
      expect(snapshotLockfile(dir, pm).exists).toBe(false);
      writeFileSync(join(dir, file), "");
      const snap = snapshotLockfile(dir, pm);
      expect(snap.exists).toBe(true);
      expect(snap.mtimeMs).toBeGreaterThan(0);
    },
  );

  it("snapshotLockfile does not match a different pm's lockfile (e.g. yarn.lock when pm=npm)", () => {
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(snapshotLockfile(dir, "npm").exists).toBe(false);
    expect(snapshotLockfile(dir, "yarn").exists).toBe(true);
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

  it("lockfileChangedSince returns true when the lockfile is newly created", () => {
    const before: LockfileSnapshot = snapshotLockfile(dir, "pnpm");
    expect(before.exists).toBe(false);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
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
});

// Round 39 follow-up #2 (Codex P1, PR #99): the install-
// recovery gate pairs `lockfileChangedSince` with a
// `node_modules` BEFORE/AFTER diff. The earlier
// `hasEnclosingNodeModules` static-existence check (initial
// follow-up) false-positived against an ambient ancestor
// `node_modules` from a prior root install — a failed install
// in a monorepo subdir that never populated dependencies
// would still pass the gate. The snapshot/diff at cwd
// specifically catches the "install touched THIS project"
// case while ignoring the parent-hoisted state.
describe("snapshotNodeModules + nodeModulesChangedSince", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "node-modules-snapshot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshotNodeModules records no-existence when cwd has no node_modules", () => {
    expect(snapshotNodeModules(dir)).toEqual({ exists: false, mtimeMs: 0 });
  });

  it("snapshotNodeModules records existence + mtime when cwd has node_modules", () => {
    mkdirSync(join(dir, "node_modules"));
    const snap = snapshotNodeModules(dir);
    expect(snap.exists).toBe(true);
    expect(snap.mtimeMs).toBeGreaterThan(0);
  });

  it("snapshotNodeModules ignores ancestor node_modules (cwd-only)", () => {
    // Round 39 P1 follow-up: the previous helper walked
    // ancestors, which let a prior root install satisfy the
    // recovery gate even when the current install never ran.
    // The cwd-only snapshot is what makes the diff meaningful.
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    expect(snapshotNodeModules(sub).exists).toBe(false);
  });

  it("nodeModulesChangedSince returns false when nothing changed", () => {
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    expect(nodeModulesChangedSince(dir, before)).toBe(false);
  });

  it("nodeModulesChangedSince returns true when node_modules is newly created", () => {
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    expect(before.exists).toBe(false);
    mkdirSync(join(dir, "node_modules"));
    expect(nodeModulesChangedSince(dir, before)).toBe(true);
  });

  it("nodeModulesChangedSince returns true when node_modules mtime advances", () => {
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(dir);
    const newer = (before.mtimeMs + 5_000) / 1000;
    utimesSync(join(dir, "node_modules"), newer, newer);
    expect(nodeModulesChangedSince(dir, before)).toBe(true);
  });

  // Round 39 P1 follow-up regression test: even with an
  // ancestor `node_modules` already on disk, the snapshot/diff
  // at cwd correctly reports "install didn't touch the
  // project" when nothing changed there.
  it("nodeModulesChangedSince ignores ancestor node_modules churn", () => {
    const sub = join(dir, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    const before: NodeModulesSnapshot = snapshotNodeModules(sub);
    // Touch the parent's node_modules — the cwd-scoped
    // snapshot must not see this as "install succeeded".
    const newer = (snapshotNodeModules(dir).mtimeMs + 5_000) / 1000;
    utimesSync(join(dir, "node_modules"), newer, newer);
    expect(nodeModulesChangedSince(sub, before)).toBe(false);
  });
});
