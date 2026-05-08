import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the @arkor/cli-internal mock from `arkor`'s init.test.ts —
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
  snapshotLockfile: vi.fn(() => ({ exists: false, mtimeMs: 0 })),
  lockfileChangedSince: vi.fn(() => false),
  isInGitRepo: vi.fn(async () => false),
  sanitise: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
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
  templateChoices: () => [
    { value: "triage", label: "Triage", hint: "fast" },
  ],
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
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { gitInitialCommit, install, scaffold } from "@arkor/cli-internal";
import { run, shellQuoteIfNeeded, shouldRunAsCli } from "./bin";

let parentDir: string;
const ORIG_CWD = process.cwd();
const ORIG_CI = process.env.CI;

beforeEach(() => {
  // Same canonicalisation dance as init.test.ts — macOS realpaths
  // `/tmp/...` to `/private/tmp/...`, and the test asserts on paths
  // derived from `process.cwd()` indirectly via the scaffold mock's
  // captured arguments.
  parentDir = realpathSync(mkdtempSync(join(tmpdir(), "create-arkor-test-")));
  process.chdir(parentDir);
  process.env.CI = "1";
  // `vi.mock()`-created mocks aren't reset by `restoreAllMocks` — it
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
  // advisory) only reaches the user through this loop — without
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
  // too — the user re-runs after fixing the advisory and the
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
    // `create-arkor` rerun copy — real users invoke via
    // `npm create` / `pnpm create` / etc, and the original flags
    // would be lost in the prescription.
    expect(infoMessages).not.toMatch(/`create-arkor`/);
  });

  // Round 21 (Codex P2, PR #99): when the user explicitly opted
  // out of install (`--skip-install`), the lockfile-ordering
  // rationale doesn't apply — there's no lockfile to wait for.
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

  // Counterpart: regression guard for the no-warning path.
  it("runs install when scaffold returns blockInstall=false (no advisory)", async () => {
    // Default mock already returns blockInstall: false.
    await run({
      dir: "target",
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
// is the resolved real file — a verbatim equality check returned
// `false` and `program.parseAsync` never ran. Lock the
// symlink-tolerant comparison down so the regression can't
// resurface; the fixture creates a real symlink with `symlinkSync`
// and asserts the helper still recognises it as the entrypoint.
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

    it("escapes embedded single quotes with the '\\'' close-literal-open sequence", () => {
      // Standard POSIX trick: 'foo'\''bar' parses as 'foo' + \' + 'bar'.
      withPlatform("linux", () => {
        expect(shellQuoteIfNeeded("it's")).toBe("'it'\\''s'");
        expect(shellQuoteIfNeeded("a'b'c")).toBe("'a'\\''b'\\''c'");
      });
    });
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

    it("double-quotes paths containing shell metacharacters", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("foo;bar")).toBe('"foo;bar"');
        expect(shellQuoteIfNeeded("foo&bar")).toBe('"foo&bar"');
      });
    });

    it("escapes embedded double quotes as \\\"", () => {
      // Practically rare, but pin the escape so a future tweak
      // doesn't drop the backslash and silently corrupt the
      // copy-paste command.
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded('a"b')).toBe('"a\\"b"');
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
    it("escapes embedded backslashes as \\\\ (CodeQL)", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("a\\b c")).toBe('"a\\\\b c"');
      });
    });

    it("escapes a trailing backslash so it doesn't absorb the closing quote", () => {
      withPlatform("win32", () => {
        // Without backslash escaping, the result would be
        // `"foo\"` — the closing quote is consumed and the
        // argument is unterminated. Doubling the trailing
        // backslash keeps it literal.
        expect(shellQuoteIfNeeded("foo\\ bar")).toBe('"foo\\\\ bar"');
      });
    });

    it("escapes a backslash-quote run round-trippably (\\\" → \\\\\\\")", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded('a\\"b')).toBe('"a\\\\\\"b"');
      });
    });

    // Round 39 (Copilot, PR #99): PowerShell interpolates `$VAR`
    // and `$()` inside double quotes, so a Windows directory
    // containing `$` (e.g. `My$App`) would let a copy-pasted
    // `cd "..." && pnpm install` evaluate a subexpression.
    // Backtick-escape `$` and `` ` `` itself so PowerShell sees
    // them as literal text. cmd.exe renders the backtick
    // literally, but cmd doesn't interpolate `$` in the first
    // place — paths with literal `$` / backtick are vanishingly
    // rare in practice.
    it("backtick-escapes `$` so PowerShell doesn't interpolate the path", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("My$App")).toBe('"My`$App"');
      });
    });

    it("backtick-escapes `$()` so PowerShell doesn't run subexpressions", () => {
      withPlatform("win32", () => {
        expect(shellQuoteIfNeeded("foo$(rm -rf /)")).toBe(
          '"foo`$(rm -rf /)"',
        );
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
});
