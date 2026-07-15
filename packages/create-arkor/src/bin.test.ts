import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the @arkor/cli-internal mock from `arkor`'s init.test.ts:
// keep the helpers cheap (no real fs / install / git) so the focused
// `run()` test below can verify orchestration without spawning real
// CLIs. The scaffold mock returns `warnings: []` by default;
// individual tests override per-call to drive the warning surface.
vi.mock("@arkor/cli-internal", () => ({
  gitInitialCommit: vi.fn(async () => ({ signingFallback: false })),
  install: vi.fn(async () => undefined),
  // Round 39 follow-up: `snapshotLockfile` returns "no lockfile
  // yet" by default and `lockfileChangedSince` defaults to false,
  // so tests exercising install-failure keep their git-skip
  // semantics. Tests that need the "install threw but lockfile
  // landed" path can override per-call via
  // `vi.mocked(lockfileChangedSince).mockReturnValueOnce(true)`.
  snapshotLockfile: vi.fn(() => ({ exists: false, path: null, mtimeMs: 0 })),
  lockfileChangedSince: vi.fn(() => false),
  // Round 39 follow-up #2: same default-false posture for the
  // `node_modules` snapshot/diff pair. Tests that exercise the
  // recovery path can override both to `true` per-call.
  snapshotNodeModules: vi.fn(() => ({
    cwd: { exists: false, mtimeMs: 0 },
    enclosing: new Map<string, number>(),
  })),
  nodeModulesChangedSince: vi.fn(() => false),
  isInGitRepo: vi.fn(async () => false),
  sanitise: (s: string) =>
    s
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 60) || "arkor-project",
  scaffold: vi.fn(async () => ({
    files: [{ action: "created", path: "package.json" }],
    warnings: [],
    blockInstall: false,
  })),
  resolvePackageManager: vi.fn(),
  TEMPLATES: {
    triage: {},
    translate: {},
    redaction: {},
  },
  templateChoices: () => [{ value: "triage", label: "Triage", hint: "fast" }],
}));

// `@clack/prompts` is mocked so `clack.intro` / `clack.log.warn`
// don't actually open a TUI and so we can assert on the warning
// surface call list.
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for("clack:cancel")),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import {
  gitInitialCommit,
  install,
  lockfileChangedSince,
  nodeModulesChangedSince,
  scaffold,
} from "@arkor/cli-internal";
import {
  buildCdLine,
  isOccupied,
  run,
  shellQuoteIfNeeded,
  shouldRunAsCli,
} from "./bin";

let parentDir: string;
const ORIG_CWD = process.cwd();
const ORIG_CI = process.env.CI;

beforeEach(() => {
  // Same canonicalisation dance as init.test.ts: macOS realpaths
  // `/tmp/...` to `/private/tmp/...`, and the test asserts on paths
  // derived from `process.cwd()` indirectly via the scaffold mock's
  // captured arguments.
  parentDir = realpathSync(mkdtempSync(join(tmpdir(), "create-arkor-test-")));
  process.chdir(parentDir);
  process.env.CI = "1";
  // `vi.mock()`-created mocks aren't reset by `restoreAllMocks`: it
  // only undoes `vi.spyOn` patches. Use `clearAllMocks` to wipe the
  // call lists so the "no warn" test isn't polluted by the prior
  // test's `clack.log.warn` invocations. The warning-surface test
  // installs a `mockResolvedValueOnce` override per call so the
  // default scaffold mock below stays the steady-state contract.
  vi.clearAllMocks();
  vi.mocked(scaffold).mockResolvedValue({
    cwd: parentDir,
    files: [{ action: "created", path: "package.json" }],
    warnings: [],
    blockInstall: false,
  });
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(parentDir, { recursive: true, force: true });
  if (ORIG_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIG_CI;
  vi.restoreAllMocks();
});

describe("create-arkor run()", () => {
  // Locks down the contract the install-matrix relies on: the pm the
  // user (or detection) chose has to reach `scaffold()` so it can
  // emit the matching `.yarnrc.yml`. A future refactor that drops
  // the forwarding would silently regress yarn-berry support;
  // Copilot's round-6 review on PR #99 flagged the missing test.
  it("forwards packageManager to scaffold()", async () => {
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      skipInstall: true,
      skipGit: true,
    });
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({ packageManager: "yarn" }),
    );
  });

  it("forwards an undefined packageManager unchanged (manual install hint flow)", async () => {
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: undefined,
      skipInstall: true,
      skipGit: true,
    });
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({ packageManager: undefined }),
    );
  });

  // Mirror of the warnings-surface test in arkor's init.test.ts.
  // The conflicting-`nodeLinker:` notice (and any future scaffold
  // advisory) only reaches the user through this loop; without
  // coverage a regression here would silently eat important
  // guidance.
  it("surfaces every scaffold warning via clack.log.warn", async () => {
    const advisories = [
      "Existing .yarnrc.yml pins `nodeLinker: pnp`. ...",
      "Some other future advisory.",
    ];
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd: parentDir,
      files: [{ action: "created", path: "package.json" }],
      warnings: advisories,
      blockInstall: false,
    });
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      skipInstall: true,
      skipGit: true,
    });
    expect(vi.mocked(clack.log.warn).mock.calls.map((c) => c[0])).toEqual(
      advisories,
    );
  });

  it("emits no clack.log.warn when scaffold returns no warnings", async () => {
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "pnpm",
      skipInstall: true,
      skipGit: true,
    });
    expect(vi.mocked(clack.log.warn)).not.toHaveBeenCalled();
  });

  // Round 17 (Copilot, PR #99): when scaffold returns
  // `blockInstall: true` (= surfaced a yarn-config advisory the user
  // must apply before install), run() MUST skip the auto-install and
  // surface a fix-then-retry hint. Otherwise we'd run `yarn install`
  // against an unfixed PnP setup, producing no node_modules and
  // leaving the project broken.
  it("skips install when scaffold returns blockInstall=true and surfaces a fix-then-retry hint", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd: parentDir,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      skipGit: true,
    });
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toContain("yarn install");
    expect(infoMessages).toMatch(/Skipping install/);
  });

  // Round 19 (Copilot, PR #99): when blockInstall is true we
  // skipped install above; running git init at this point would
  // commit a tree without `node_modules`/lockfile, breaking the
  // "lockfile lands in the initial commit" invariant. Skip git
  // too: the user re-runs after fixing the advisory and the
  // next run produces a single bootstrap commit with the
  // lockfile included.
  it("skips git init when scaffold returns blockInstall=true (preserves lockfile-in-initial-commit invariant)", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd: parentDir,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      git: true, // explicit --git → would normally trigger runGitInit
    });
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toMatch(/Skipping git init/);
    expect(infoMessages).toMatch(/re-run this command/);
    // Round 21 (Copilot, PR #99) dropped the prescriptive
    // `create-arkor` rerun copy: real users invoke via
    // `npm create` / `pnpm create` / etc, and the original flags
    // would be lost in the prescription.
    expect(infoMessages).not.toMatch(/`create-arkor`/);
  });

  // Round 21 (Codex P2, PR #99): when the user explicitly opted
  // out of install (`--skip-install`), the lockfile-ordering
  // rationale doesn't apply: there's no lockfile to wait for.
  // Honor an explicit `--git` request even when scaffold returns
  // blockInstall=true.
  it("STILL runs git init when blockInstall=true but install was explicitly skipped via --skip-install", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd: parentDir,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      skipInstall: true,
      git: true,
    });
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    expect(vi.mocked(gitInitialCommit)).toHaveBeenCalled();
  });

  // Round 35 (Copilot, PR #99): when install was attempted but
  // FAILED (caught error), the previous code still ran git init
  // on the no-lockfile tree, breaking the bootstrap-commit
  // invariant. Skip git too and surface a recovery hint.
  it("skips git init when install was attempted but threw (lockfile-in-initial-commit invariant)", async () => {
    vi.mocked(install).mockRejectedValueOnce(
      new Error("`yarn install` exited with code 7"),
    );
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      git: true,
    });
    expect(vi.mocked(install)).toHaveBeenCalled();
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toMatch(/Skipping git init/);
    expect(infoMessages).toMatch(/yarn install.*failed/);
    expect(infoMessages).toMatch(/re-run this command/);
  });

  // Round 40 (Copilot, PR #99): mirror of arkor init's
  // recovered-artefacts test. install throws + lockfile +
  // node_modules diffs flip to true + pm is pnpm (in the
  // recovery allow-list). git is NOT auto-run (strict gate),
  // but the skip-git message says "looks populated, inspect and
  // commit manually" and the outro (multi-line for create-arkor)
  // shows the install line as null (treeIsReady=true).
  it("on install throw + artefacts landed + pnpm: skips git with recovered-artefacts message, outro omits install step", async () => {
    vi.mocked(install).mockRejectedValueOnce(
      new Error("`pnpm install` exited with code 1"),
    );
    vi.mocked(lockfileChangedSince).mockReturnValueOnce(true);
    vi.mocked(nodeModulesChangedSince).mockReturnValueOnce(true);
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "pnpm",
      git: true,
    });
    expect(vi.mocked(install)).toHaveBeenCalled();
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    // No inline "Retry manually": the skip-git message + outro
    // cover the next step.
    expect(infoMessages).not.toMatch(/Retry manually/);
    expect(infoMessages).toMatch(/look populated/);
    expect(infoMessages).toMatch(/inspect the tree/);
    const outroMessages = vi
      .mocked(clack.outro)
      .mock.calls.map((c) => c[0])
      .join("\n");
    // Outro is multi-line for create-arkor; treeIsReady=true
    // means the install line is OMITTED (no `<pm> install`).
    expect(outroMessages).not.toMatch(/^ {2}pnpm install/m);
    // The three git commands are on separate lines (round-40
    // follow-up #3: no single chain separator works in cmd.exe
    // and PS 5.1 simultaneously).
    expect(outroMessages).toMatch(/^ {2}git init$/m);
    expect(outroMessages).toMatch(/^ {2}git add -A$/m);
    expect(outroMessages).toMatch(
      /^ {2}git commit -m "Initial commit from Create Arkor"$/m,
    );
    // Manual git commands appear before the dev command (order
    // matters for the natural "init repo, then start dev"
    // sequence).
    const gitIdx = outroMessages.indexOf("git init");
    const devIdx = outroMessages.indexOf("pnpm arkor dev");
    expect(gitIdx).toBeGreaterThanOrEqual(0);
    expect(devIdx).toBeGreaterThan(gitIdx);
  });

  it("on install throw + artefacts landed + npm: NOT in recovery allow-list, falls through to failure message", async () => {
    vi.mocked(install).mockRejectedValueOnce(
      new Error("`npm install` exited with code 1"),
    );
    vi.mocked(lockfileChangedSince).mockReturnValueOnce(true);
    vi.mocked(nodeModulesChangedSince).mockReturnValueOnce(true);
    const clack = await import("@clack/prompts");
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "npm",
      git: true,
    });
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toMatch(/Retry manually/);
    expect(infoMessages).not.toMatch(/look populated/);
  });

  // Counterpart: regression guard for the no-warning path.
  it("runs install when scaffold returns blockInstall=false (no advisory)", async () => {
    // Default mock already returns blockInstall: false.
    await run({
      dir: "target",
      agentsMd: false,
      yes: true,
      template: "triage",
      packageManager: "yarn",
      skipGit: true,
    });
    expect(vi.mocked(install)).toHaveBeenCalledWith("yarn", expect.any(String));
  });
});

// PR #99 round 7 (Codex P1 + Copilot): the entrypoint guard a
// previous round added to make `bin.ts` safe to import under
// vitest broke `npm create arkor` / `pnpm create arkor` / `npx`.
// Those launchers run the bin via a `node_modules/.bin/<name>`
// shim, so `process.argv[1]` is the symlink while `import.meta.url`
// is the resolved real file: a verbatim equality check returned
// `false` and `program.parseAsync` never ran. Lock the
// symlink-tolerant comparison down so the regression can't
// resurface; the fixture creates a real symlink with `symlinkSync`
// and asserts the helper still recognises it as the entrypoint.
describe("isOccupied", () => {
  let occDir: string;
  beforeEach(() => {
    occDir = mkdtempSync(join(tmpdir(), "create-arkor-occ-"));
  });
  afterEach(() => {
    rmSync(occDir, { recursive: true, force: true });
  });

  it("reports a non-existent path as free", async () => {
    await expect(isOccupied(join(occDir, "nope"))).resolves.toBe(false);
  });

  it("reports an empty dir as free and a non-empty dir as occupied", async () => {
    const empty = join(occDir, "empty");
    mkdirSync(empty);
    await expect(isOccupied(empty)).resolves.toBe(false);
    writeFileSync(join(empty, "f.txt"), "x");
    await expect(isOccupied(empty)).resolves.toBe(true);
  });

  it("reports a plain file as occupied", async () => {
    const f = join(occDir, "file");
    writeFileSync(f, "x");
    await expect(isOccupied(f)).resolves.toBe(true);
  });

  // ENG-933: existsSync followed symlinks, so a broken (dangling) symlink
  // reported "free" and the collision guard was bypassed. lstat inspects the
  // link itself. Symlink-to-nonexistent needs privileges on Windows, so this
  // case is POSIX-only.
  it("reports a broken symlink as occupied (POSIX)", async () => {
    if (process.platform === "win32") return;
    const link = join(occDir, "dangling");
    symlinkSync(join(occDir, "does-not-exist"), link);
    await expect(isOccupied(link)).resolves.toBe(true);
  });
});

describe("shouldRunAsCli", () => {
  let tmp: string;
  let realFile: string;
  let realFileUrl: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "create-arkor-cli-check-")));
    realFile = join(tmp, "bin.mjs");
    writeFileSync(realFile, "// test fixture\n");
    realFileUrl = pathToFileURL(realFile).href;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for direct invocation (argv[1] == module file)", () => {
    expect(shouldRunAsCli(realFile, realFileUrl)).toBe(true);
  });

  it("returns true when argv[1] is a symlink resolving to the module file (npm/pnpm/npx bin shim)", () => {
    const link = join(tmp, "shim.mjs");
    symlinkSync(realFile, link);
    expect(shouldRunAsCli(link, realFileUrl)).toBe(true);
  });

  it("returns false when argv[1] points to an unrelated script (vitest worker)", () => {
    const other = join(tmp, "other.mjs");
    writeFileSync(other, "// not us\n");
    expect(shouldRunAsCli(other, realFileUrl)).toBe(false);
  });

  it("returns false when argv[1] is missing", () => {
    expect(shouldRunAsCli(undefined, realFileUrl)).toBe(false);
  });
});

// Round 39 (Copilot, PR #99): the `cd ${cdTarget}` recovery
// hints are copy-paste shell commands. A target with spaces or
// shell metacharacters would otherwise emit a broken
// `cd My App && pnpm install`. `shellQuoteIfNeeded` keeps the
// safe-character common case unquoted (so "my-app" stays clean)
// and POSIX-quotes / Windows-double-quotes the rest depending on
// `process.platform` (round-39 Codex P2 / Copilot follow-up:
// `cmd.exe` treats single quotes as literal characters, so a
// blanket POSIX strategy broke copy-paste on Windows).
describe("shellQuoteIfNeeded", () => {
  // Helper: temporarily override `process.platform` for one
  // assertion. Node's `process.platform` is a non-writable
  // string by default; `Object.defineProperty` with
  // `configurable: true` lets us swap and restore.
  function withPlatform(platform: NodeJS.Platform, fn: () => void) {
    const orig = process.platform;
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", {
        value: orig,
        configurable: true,
      });
    }
  }

  it("leaves alphanumeric / dotted / slashed paths unquoted (any platform)", () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        expect(shellQuoteIfNeeded("my-app")).toBe("my-app");
        expect(shellQuoteIfNeeded("apps/foo")).toBe("apps/foo");
        expect(shellQuoteIfNeeded("./packages/bar")).toBe("./packages/bar");
        expect(shellQuoteIfNeeded("v1.2.3")).toBe("v1.2.3");
        expect(shellQuoteIfNeeded("@scope/pkg")).toBe("@scope/pkg");
      });
    }
  });

  describe("POSIX (linux / darwin)", () => {
    it("single-quotes paths containing spaces", () => {
      withPlatform("linux", () => {
        expect(shellQuoteIfNeeded("My App")).toBe("'My App'");
      });
    });

    it("single-quotes paths containing shell metacharacters", () => {
      withPlatform("linux", () => {
        expect(shellQuoteIfNeeded("foo;rm -rf /")).toBe("'foo;rm -rf /'");
        expect(shellQuoteIfNeeded("foo$bar")).toBe("'foo$bar'");
        expect(shellQuoteIfNeeded("foo`whoami`")).toBe("'foo`whoami`'");
        expect(shellQuoteIfNeeded("foo&bar")).toBe("'foo&bar'");
      });
    });

    // ENG-933: comma is a legal filename char but PowerShell's array operator,
    // so it must be quoted, not left bare (it's quoted on POSIX too for a
    // consistent, copy-pasteable hint).
    it("single-quotes paths containing a comma", () => {
      withPlatform("linux", () => {
        expect(shellQuoteIfNeeded("my,dir")).toBe("'my,dir'");
      });
    });

    it(
      String.raw`escapes embedded single quotes with the '\'' close-literal-open sequence`,
      () => {
        // Standard POSIX trick: 'foo'\''bar' parses as 'foo' + \' + 'bar'.
        withPlatform("linux", () => {
          expect(shellQuoteIfNeeded("it's")).toBe(String.raw`'it'\''s'`);
          expect(shellQuoteIfNeeded("a'b'c")).toBe(String.raw`'a'\''b'\''c'`);
        });
      },
    );
  });

  describe("Windows (win32)", () => {
    // `cmd.exe` and PowerShell both honour double quotes for
    // grouping a path with spaces. Single quotes would copy-
    // paste-fail in `cmd.exe` (it treats `'` as a literal).
    it("double-quotes paths containing spaces", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("My App")).toBe('"My App"');
      });
    });

    // ENG-933: `cd my,dir` in PowerShell parses the comma as the array
    // operator and errors; the path must be double-quoted.
    it("double-quotes paths containing a comma", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("my,dir")).toBe('"my,dir"');
      });
    });

    it("double-quotes paths containing shell metacharacters", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("foo;bar")).toBe('"foo;bar"');
        expect(shellQuoteIfNeeded("foo&bar")).toBe('"foo&bar"');
      });
    });

    it(String.raw`escapes embedded double quotes as \"`, () => {
      // Practically rare, but pin the escape so a future tweak
      // doesn't drop the backslash and silently corrupt the
      // copy-paste command.
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded('a"b')).toBe(String.raw`"a\"b"`);
      });
    });

    // Round 39 (CodeQL, PR #99): the Windows quoter must escape
    // backslashes BEFORE quotes (`\` → `\\`, then `"` → `\"`),
    // matching the Windows `_setargv` / msvcrt parsing
    // convention used by both PowerShell and the standard
    // `cmd.exe` argv path. Otherwise a trailing backslash in
    // the quoted value would absorb the closing `"` and
    // un-terminate the argument; a `\\"` run would also be
    // double-decoded by downstream commands.
    it(String.raw`escapes embedded backslashes as \\ (CodeQL)`, () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded(String.raw`a\b c`)).toBe(
          String.raw`"a\\b c"`,
        );
      });
    });

    it("escapes a trailing backslash so it doesn't absorb the closing quote", () => {
      withPlatform("win32", () => {
        // Without backslash escaping, the result would be
        // `"foo\"`: the closing quote is consumed and the
        // argument is unterminated. Doubling the trailing
        // backslash keeps it literal.
        expect(shellQuoteIfNeeded(String.raw`foo\ bar`)).toBe(
          String.raw`"foo\\ bar"`,
        );
      });
    });

    it(
      String.raw`escapes a backslash-quote run round-trippably (\" → \\\")`,
      () => {
        withPlatform("win32", () => {
          expect(shellQuoteIfNeeded(String.raw`a\"b`)).toBe(
            String.raw`"a\\\"b"`,
          );
        });
      },
    );

    // Round 39 (Copilot, PR #99): PowerShell interpolates `$VAR`
    // and `$()` inside double quotes, so a Windows directory
    // containing `$` (e.g. `My$App`) would let a copy-pasted
    // `cd "..." && pnpm install` evaluate a subexpression.
    // Backtick-escape `$` and `` ` `` itself so PowerShell sees
    // them as literal text. cmd.exe renders the backtick
    // literally, but cmd doesn't interpolate `$` in the first
    // place; paths with literal `$` / backtick are vanishingly
    // rare in practice.
    it("backtick-escapes `$` so PowerShell doesn't interpolate the path", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("My$App")).toBe('"My`$App"');
      });
    });

    it("backtick-escapes `$()` so PowerShell doesn't run subexpressions", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("foo$(rm -rf /)")).toBe('"foo`$(rm -rf /)"');
      });
    });

    it("doubles a literal backtick (PowerShell escape char) so it stays literal", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("foo`bar")).toBe('"foo``bar"');
      });
    });

    it("escapes backtick FIRST so a `$` in the input doesn't get re-escaped", () => {
      // Run order matters: if `$` were escaped before the
      // backtick step, the `` ` `` we just inserted would itself
      // be doubled to `` `` ``. The implementation escapes
      // backtick first so the synthetic `` ` `` survives the
      // following `$` replace step intact.
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("a`$b")).toBe('"a```$b"');
      });
    });
  });

  // Round 40 (Copilot, PR #99): a leading dash makes POSIX
  // shells, PowerShell, AND cmd.exe treat the argument as an
  // option/switch even when the value is quoted (the shell
  // strips the quotes before `cd` sees the argument). The
  // implementation path-disambiguates by prefixing `./` (POSIX)
  // or `.\` (Windows) before the safe-unquote / quoting paths
  // run, so the resulting hint hands `cd` an unambiguous
  // relative path. Lock that contract down here so a future
  // quoting refactor doesn't regress the option-parser bypass.
  describe("leading-dash paths (option-parser disambiguation)", () => {
    it("prefixes ./ on POSIX for a bare leading-dash name", () => {
      withPlatform("linux", () => {
        // After ./-prefix the remaining chars are safe alphanums,
        // so the safe-unquote regex matches and no quoting is
        // applied: the output stays a bare `./-foo`.
        expect(shellQuoteIfNeeded("-foo")).toBe("./-foo");
        expect(shellQuoteIfNeeded("--foo")).toBe("./--foo");
        expect(shellQuoteIfNeeded("-")).toBe("./-");
      });
    });

    it("prefixes .\\ on Windows for a bare leading-dash name (quoted; msvcrt-style `\\` doubling applied by the win32 quoter)", () => {
      withPlatform("win32", () => {
        // On Windows, the existing win32 quoter escapes `\` to
        // `\\` to satisfy `_setargv` / msvcrt argv parsing when
        // the quoted path is forwarded to a child program. The
        // path-disambiguation `.\` prefix flows through the same
        // escape, so the bytes are `\\` inside the quoted form
        // (Windows path normalization collapses `.\\-foo` to
        // `.\-foo` for `cd` / `Set-Location`, so the doubling is
        // functionally benign).
        expect(shellQuoteIfNeeded("-foo")).toBe(String.raw`".\\-foo"`);
        expect(shellQuoteIfNeeded("--foo")).toBe(String.raw`".\\--foo"`);
      });
    });

    it("combines the ./ prefix with single-quoting on POSIX when the name also has a space", () => {
      withPlatform("linux", () => {
        // The prefix is applied BEFORE quoting, so the resulting
        // single-quoted form contains `./` inside the quotes.
        expect(shellQuoteIfNeeded("-foo bar")).toBe("'./-foo bar'");
      });
    });

    it(
      String.raw`combines the .\ prefix with double-quoting on Windows when the name also has a space`,
      () => {
        withPlatform("win32", () => {
          // Same `\\` doubling as above; the space triggers
          // double-quoting which subsumes the bare ./--prefix path.
          expect(shellQuoteIfNeeded("-foo bar")).toBe(
            String.raw`".\\-foo bar"`,
          );
        });
      },
    );

    it("does NOT prefix names that don't start with `-` even when they contain a dash later", () => {
      withPlatform("linux", () => {
        expect(shellQuoteIfNeeded("my-app")).toBe("my-app");
        expect(shellQuoteIfNeeded("foo-bar")).toBe("foo-bar");
      });
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("my-app")).toBe("my-app");
      });
    });
  });
});

// Round 40 follow-up (Copilot, PR #99): the standalone `cd
// <dir>` line that create-arkor's multi-line outro prints
// shares the same `%`-on-Windows expansion hazard documented
// on `shellQuoteIfNeeded`. `buildCdLine` mitigates by
// switching to a PS-single-quoted form when `%` is present.
// These tests pin the helper directly.
describe("buildCdLine", () => {
  const ORIG_PLATFORM = process.platform;
  function withPlatform(p: NodeJS.Platform, fn: () => void) {
    Object.defineProperty(process, "platform", {
      value: p,
      configurable: true,
    });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", {
        value: ORIG_PLATFORM,
        configurable: true,
      });
    }
  }

  it("emits a POSIX single-quoted cd line for ordinary paths", () => {
    withPlatform("linux", () => {
      expect(buildCdLine("my-app")).toBe("cd my-app");
      expect(buildCdLine("My App")).toBe("cd 'My App'");
    });
  });

  it("emits a Windows double-quoted cd line for ordinary paths", () => {
    withPlatform("win32", () => {
      expect(buildCdLine("my-app")).toBe("cd my-app");
      expect(buildCdLine("My App")).toBe('cd "My App"');
    });
  });

  it("falls back to a PowerShell single-quoted cd line on Windows when the path contains `%`", () => {
    withPlatform("win32", () => {
      expect(buildCdLine("My%FOO%App")).toBe("cd 'My%FOO%App'");
    });
  });

  it("keeps POSIX single-quoted form when the path contains `%` (no cmd.exe expansion to mitigate)", () => {
    withPlatform("linux", () => {
      expect(buildCdLine("My%FOO%App")).toBe("cd 'My%FOO%App'");
    });
  });

  // Round 40 follow-up (Copilot, PR #99): the `%`-path PS
  // fallback used to bypass `shellQuoteIfNeeded`'s leading-dash
  // disambiguation, so a directory named `-foo%bar%` emitted
  // `cd '-foo%bar%'` and PowerShell parsed `-foo` as an option
  // to `Set-Location` (PS strips quotes before option parsing).
  // The fallback now prefixes leading-dash paths with `.\` so
  // the path is unambiguous to `Set-Location`.
  it("prefixes leading-dash paths with .\\ in the `%`/PS fallback (Windows)", () => {
    withPlatform("win32", () => {
      expect(buildCdLine("-foo%bar%")).toBe(String.raw`cd '.\-foo%bar%'`);
    });
  });

  it("leaves non-leading-dash `%`-paths unchanged in the PS fallback", () => {
    withPlatform("win32", () => {
      expect(buildCdLine("My-%FOO%-App")).toBe("cd 'My-%FOO%-App'");
    });
  });
});

// `buildCdAndRun` was removed in round-40 follow-up #4 (Codex
// P2, PR #99): no single chain separator works across all
// supported shells (`&&` breaks PowerShell 5.1; `;` is literal
// in cmd.exe), so the inline `cd "..." && <pm> install`
// recovery hints were reworded as prose ("run `<pm> install`
// in `<path>`"). `buildCdLine` covers the remaining cd-line
// use case (multi-line outro) and is tested above.
