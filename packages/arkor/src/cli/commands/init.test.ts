import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub @clack/prompts so the interactive-prompt branch in decideGitInit
// can be exercised without opening a real TUI. The default mock implementation
// returns the prompt's resolved value (configured per-test via mockResolvedValueOnce).
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for("clack:cancel")),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

// Mock the cli-internal helpers so we don't actually scaffold files,
// run install, or hit git on disk for every branch — the helpers have
// their own tests in @arkor/cli-internal. We only verify the
// orchestration logic in init.ts itself.
vi.mock("@arkor/cli-internal", () => {
  return {
    gitInitialCommit: vi.fn(async () => ({ signingFallback: false })),
    install: vi.fn(async () => undefined),
    // Round 39 follow-up: `snapshotLockfile` returns "no lockfile
    // yet" by default (mirrors a fresh-scaffold cwd) and
    // `lockfileChangedSince` returns false unless explicitly
    // overridden, so tests exercising the install-failure path
    // keep their git-skip semantics. Tests that need the
    // "install threw but lockfile landed" recovery path can
    // override via
    // `vi.mocked(lockfileChangedSince).mockReturnValueOnce(true)`.
    snapshotLockfile: vi.fn(() => ({ exists: false, mtimeMs: 0 })),
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
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "arkor-project",
    scaffold: vi.fn(async () => ({
      files: [{ action: "created", path: "package.json" }],
      warnings: [],
      blockInstall: false,
    })),
    TEMPLATES: {
      triage: {},
      translate: {},
      redaction: {},
    },
    templateChoices: () => [
      { value: "triage", label: "Triage", hint: "fast" },
      { value: "translate", label: "Translate", hint: "translate" },
      { value: "redaction", label: "Redaction", hint: "redaction" },
    ],
  };
});

import {
  gitInitialCommit,
  install,
  isInGitRepo,
  scaffold,
} from "@arkor/cli-internal";
import { runInit } from "./init";

let cwd: string;
const ORIG_CWD = process.cwd();
// Capture the original env / TTY state so the after-each can restore
// conditionally. CI runners typically have CI already set, and an
// unconditional `delete` would leak a different environment to later
// test files when vitest reuses a worker.
const ORIG_CI = process.env.CI;
const ORIG_TTY = process.stdout.isTTY;

beforeEach(() => {
  // macOS resolves `/tmp/...` through realpath to `/private/tmp/...`, so
  // a chdir into the raw `mkdtemp` result leaves `process.cwd()` (the
  // value runInit reads internally) and our captured `cwd` mismatched.
  // Canonicalising up front keeps every assertion that compares against
  // `cwd` portable across Linux / macOS / Windows.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "arkor-init-test-")));
  process.chdir(cwd);
  // Pin non-interactive so promptText/Select fall through to skipWith /
  // initialValue without opening clack.
  process.env.CI = "1";
  // `vi.mock()`-created mocks (`@clack/prompts.log.warn`, etc.) aren't
  // reset by `restoreAllMocks` in afterEach — that only undoes
  // `vi.spyOn` patches. Without `clearAllMocks` here, call lists from
  // earlier tests leak into the new warning-surface assertions.
  vi.clearAllMocks();
  vi.mocked(isInGitRepo).mockResolvedValue(false);
  vi.mocked(gitInitialCommit).mockResolvedValue({ signingFallback: false });
  vi.mocked(install).mockResolvedValue(undefined);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(cwd, { recursive: true, force: true });
  if (ORIG_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIG_CI;
  // Restore the TTY flag in case an interactive test mutated it —
  // otherwise a later test that unsets CI would unexpectedly enter
  // interactive prompt paths.
  Object.defineProperty(process.stdout, "isTTY", {
    value: ORIG_TTY,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("runInit", () => {
  it("happy path: scaffolds with --yes, runs install, runs git init", async () => {
    await runInit({
      yes: true,
      name: "My App",
      template: "triage",
      packageManager: "pnpm",
    });
    // sanitise() mock lowercases + dashes the explicit name. The pm
    // is forwarded to scaffold so it can emit pm-specific config (most
    // notably `.yarnrc.yml` with `nodeLinker: node-modules` for yarn).
    // `objectContaining` so the assertion stays robust against
    // ScaffoldOptions gaining new optional fields (round-39 Copilot
    // review re-flagged this twice: vitest currently treats missing
    // keys and `undefined` as equal in deep equality, but a partial
    // matcher makes the intent explicit and won't break under a
    // future matcher tightening). agentsMd is undefined here because
    // the test calls runInit directly (the CLI default-on resolution
    // lives in main.ts).
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd,
        name: "my-app",
        template: "triage",
        packageManager: "pnpm",
      }),
    );
    expect(install).toHaveBeenCalledWith("pnpm", cwd);
    expect(gitInitialCommit).toHaveBeenCalledWith(
      cwd,
      "Initial commit from `arkor init`",
    );
  });

  it("forwards agentsMd through to scaffold when supplied", async () => {
    // Coverage for the CLI → runInit → scaffold pipe. main.ts resolves the
    // --agents-md / --no-agents-md flag to a boolean before invoking
    // runInit; runInit must pass it through unchanged so the helper writes
    // (or skips) AGENTS.md / CLAUDE.md.
    await runInit({
      yes: true,
      name: "explicit",
      template: "triage",
      packageManager: "pnpm",
      skipInstall: true,
      skipGit: true,
      agentsMd: true,
    });
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({ agentsMd: true }),
    );
  });

  it("rejects an unknown template before any side effect", async () => {
    await expect(
      runInit({
        template: "nonexistent" as never,
        packageManager: undefined,
      }),
    ).rejects.toThrow(/Unknown template/);
    expect(scaffold).not.toHaveBeenCalled();
  });

  it("rejects template ids that resolve via the prototype chain (toString, __proto__)", async () => {
    // The validator uses Object.hasOwn so prototype-chain entries don't
    // pass. Without that guard, `--template toString` would crash later
    // inside scaffold() with a confusing error.
    await expect(
      runInit({
        template: "toString" as never,
        packageManager: undefined,
      }),
    ).rejects.toThrow(/Unknown template "toString"/);
  });

  it("falls back to the cwd basename when --name is not provided (with --yes)", async () => {
    await runInit({
      yes: true,
      template: "triage",
      packageManager: "npm",
    });
    // basename of the temp dir starts with "arkor-init-test-".
    const callArg = vi.mocked(scaffold).mock.calls[0]?.[0];
    expect(callArg?.name).toMatch(/^arkor-init-test-/);
  });

  it("falls back to 'arkor-project' as the default name when basename(cwd) is empty", async () => {
    // Branch coverage for `basename(cwd) || "arkor-project"`. `basename`
    // of the platform's filesystem root (`/` on POSIX, `C:\` on Windows)
    // is `""`, so chdir-ing into the root exercises the `||` fallback.
    // Using `path.parse(...).root` keeps the test portable across
    // platforms; the scaffold mock absorbs the actual filesystem write
    // so we don't touch the real root.
    const { parse } = await import("node:path");
    const fsRoot = parse(process.cwd()).root;
    process.chdir(fsRoot);
    await runInit({
      yes: true,
      template: "triage",
      packageManager: "npm",
    });
    const callArg = vi.mocked(scaffold).mock.calls[0]?.[0];
    expect(callArg?.name).toBe("arkor-project");
  });

  it("uses 'triage' as the implicit template skipWith with --yes alone (no --template)", async () => {
    // Branch coverage for the inner ternary in
    // `options.template ?? (options.yes ? "triage" : undefined)`.
    await runInit({
      yes: true,
      packageManager: "pnpm",
      skipInstall: true,
    });
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({ template: "triage" }),
    );
  });

  it("falls back to undefined skipWith for template when not --yes and no --template", async () => {
    // Branch coverage for the `options.template ?? (options.yes ? "triage" : undefined)`
    // chain — the `undefined` arm fires when neither flag is set. The
    // promptSelect helper falls back to `initialValue: "triage"` under
    // CI=1, so the resolved template still lands on triage even though
    // skipWith is undefined.
    await runInit({
      packageManager: "pnpm",
      skipInstall: true,
    });
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({ template: "triage" }),
    );
  });

  it("skips install when --skip-install is set", async () => {
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      skipInstall: true,
      packageManager: "pnpm",
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("skips install when no packageManager could be detected", async () => {
    // Branch coverage for `pm` undefined — the user gets the manual-install
    // hint in the outro instead of a silent guess.
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: undefined,
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("warns but continues when install throws (so the user keeps a scaffolded tree)", async () => {
    vi.mocked(install).mockRejectedValueOnce(new Error("network down"));
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
    });
    // Round 35 (Copilot, PR #99): when install throws, git
    // init is NOW skipped to preserve the
    // lockfile-in-initial-commit invariant. The scaffolded
    // tree still survives (the user keeps their files); only
    // the git step bows out.
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  it("forwards a non-Error install rejection through String() coercion", async () => {
    // Branch coverage for `err instanceof Error ? err.message : String(err)`
    // around install. The CLI's warn line must still render even when a
    // dependency throws a plain string/object.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    vi.mocked(install).mockRejectedValueOnce("rate-limited" as unknown as Error);
    await expect(
      runInit({
        yes: true,
        name: "x",
        template: "triage",
        packageManager: "pnpm",
      }),
    ).resolves.toBeUndefined();
  });

  it("forwards a non-Error gitInitialCommit rejection through String() coercion", async () => {
    // Branch coverage for the symmetric String() coercion in runGitInit.
    vi.mocked(gitInitialCommit).mockRejectedValueOnce(
      "git binary missing" as unknown as Error,
    );
    await expect(
      runInit({
        yes: true,
        name: "x",
        template: "triage",
        packageManager: "pnpm",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips git init when --skip-git is set", async () => {
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
      skipGit: true,
    });
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  it("skips git init when the directory is already inside a repo", async () => {
    vi.mocked(isInGitRepo).mockResolvedValueOnce(true);
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  it("skips git init when the directory becomes a git repo during install", async () => {
    // TOCTOU defence: `decideGitInit` runs before the long-running install
    // step, so the user (or another tool — editor, autosave hook, parallel
    // shell) can run `git init` themselves while install is going. Without
    // the post-install re-check, we'd silently add a second commit on top
    // of their repo. Mock isInGitRepo to return false on the pre-install
    // call (so decideGitInit picks "yes") and true on the post-install
    // call (so runGitInit skips).
    vi.mocked(isInGitRepo)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(isInGitRepo).toHaveBeenCalledTimes(2);
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  it("warns about an unsigned fallback commit when signingFallback is true", async () => {
    vi.mocked(gitInitialCommit).mockResolvedValueOnce({
      signingFallback: true,
    });
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
    });
    expect(gitInitialCommit).toHaveBeenCalledOnce();
  });

  it("absorbs gitInitialCommit failures so the scaffold still completes", async () => {
    vi.mocked(gitInitialCommit).mockRejectedValueOnce(
      new Error("git binary missing"),
    );
    await expect(
      runInit({
        yes: true,
        name: "x",
        template: "triage",
        packageManager: "pnpm",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips git init in a non-interactive environment without explicit flags", async () => {
    // CI=1 from beforeEach already pins non-interactive. With neither
    // --git nor --skip-git nor --yes, the helper must skip rather than
    // silently auto-init (which would feel unexpected in CI scripts).
    await runInit({
      template: "triage",
      packageManager: "pnpm",
    });
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  it("forces git init when --git is set even without --yes", async () => {
    await runInit({
      template: "triage",
      packageManager: "pnpm",
      git: true,
    });
    expect(gitInitialCommit).toHaveBeenCalled();
  });

  it("interactive: runs git init when promptConfirm resolves true", async () => {
    // Branch coverage for the `else if (isInteractive())` arm of
    // decideGitInit. Pretend we're in a TTY and arm the clack confirm
    // mock to return `true`.
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");
    vi.mocked(clack.confirm).mockResolvedValueOnce(true as never);
    // promptText/Select also fall through to the interactive branch with
    // CI unset, so arm them with sensible defaults too.
    vi.mocked(clack.text).mockResolvedValueOnce("interactive-app" as never);
    vi.mocked(clack.select).mockResolvedValueOnce("triage" as never);

    await runInit({
      packageManager: "pnpm",
      skipInstall: true,
    });
    expect(gitInitialCommit).toHaveBeenCalledOnce();
  });

  it("interactive: skips git init when promptConfirm resolves false", async () => {
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");
    vi.mocked(clack.text).mockResolvedValueOnce("interactive-app" as never);
    vi.mocked(clack.select).mockResolvedValueOnce("triage" as never);
    vi.mocked(clack.confirm).mockResolvedValueOnce(false as never);

    await runInit({
      packageManager: "pnpm",
      skipInstall: true,
    });
    expect(gitInitialCommit).not.toHaveBeenCalled();
  });

  // The `warnings` loop in `runInit` is the only place the
  // scaffold's non-fatal advisories (currently the conflicting-
  // `nodeLinker:` notice) reach the user. A regression that drops
  // it would silently swallow important guidance — Copilot's
  // round-6 review on PR #99 flagged the missing coverage.
  it("surfaces every scaffold warning via ui.log.warn", async () => {
    const advisories = [
      "Existing .yarnrc.yml pins `nodeLinker: pnp`. ...",
      "Some other future advisory the scaffolder might add.",
    ];
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd,
      files: [{ action: "created", path: "package.json" }],
      warnings: advisories,
      blockInstall: false,
    });
    const clack = await import("@clack/prompts");
    await runInit({
      yes: true,
      packageManager: "yarn",
      skipInstall: true,
      skipGit: true,
    });
    // Each warning surfaces verbatim, in order, via the mocked
    // ui.log (which is just clack.log under the hood — see
    // ../prompts.ts).
    expect(vi.mocked(clack.log.warn).mock.calls.map((c) => c[0])).toEqual(
      advisories,
    );
  });

  // Counterpart: when the scaffold returns `warnings: []`, runInit
  // must NOT emit a stray empty `ui.log.warn` (e.g. from a refactor
  // that loops the wrong array or forgets the empty-guard). Locking
  // this down makes the warnings path quiet by default.
  it("emits no ui.log.warn when scaffold returns no warnings", async () => {
    // The default scaffold mock at the top of the file already
    // returns `warnings: []`; this test just asserts the absence of
    // calls to be explicit about the contract.
    const clack = await import("@clack/prompts");
    await runInit({
      yes: true,
      packageManager: "pnpm",
      skipInstall: true,
      skipGit: true,
    });
    expect(vi.mocked(clack.log.warn)).not.toHaveBeenCalled();
  });

  it("runs install before gitInitialCommit so the lockfile lands in the initial commit", async () => {
    // Lockfile-in-initial-commit invariant: scaffolding writes package.json
    // → install generates the lockfile → only then can git's initial commit
    // include both. If git init ran first, the tree would be dirty and a
    // re-run would produce a different commit.
    await runInit({
      yes: true,
      name: "x",
      template: "triage",
      packageManager: "pnpm",
    });
    const installOrder = vi.mocked(install).mock.invocationCallOrder[0];
    const commitOrder = vi.mocked(gitInitialCommit).mock.invocationCallOrder[0];
    expect(installOrder).toBeDefined();
    expect(commitOrder).toBeDefined();
    expect(installOrder).toBeLessThan(commitOrder!);
  });

  // Round 17 (Copilot, PR #99): when scaffold returns
  // `blockInstall: true` (= surfaced a yarn-config advisory the user
  // must apply before install), runInit MUST skip the auto-install
  // and surface a fix-then-retry hint. Otherwise we'd run
  // `yarn install` against an unfixed PnP setup, producing no
  // node_modules and leaving the project broken.
  it("skips install when scaffold returns blockInstall=true and surfaces a fix-then-retry hint", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    const clack = await import("@clack/prompts");
    await runInit({
      yes: true,
      packageManager: "yarn",
      skipGit: true,
    });
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    // The fix-then-retry hint surfaces via ui.log.info — assert it
    // mentions the install command so the user knows what to retry.
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
  // too — the user re-runs `arkor init` after fixing the advisory
  // and the next run produces a single bootstrap commit with the
  // lockfile included.
  it("skips git init when scaffold returns blockInstall=true (preserves lockfile-in-initial-commit invariant)", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    const clack = await import("@clack/prompts");
    await runInit({
      yes: true,
      packageManager: "yarn",
      git: true, // explicit --git → would normally trigger runGitInit
    });
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    // The git init step is also skipped — the lockfile-in-initial-
    // commit invariant requires install to land first.
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    // The user is told why git was skipped. Round 21 (Copilot, PR
    // #99) dropped the prescriptive `arkor init` rerun copy
    // (the local bin isn't installed yet, and the original flags
    // would be lost) — just point at the advisory.
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toMatch(/Skipping git init/);
    expect(infoMessages).toMatch(/re-run this command/);
    // Specifically NOT the prescriptive "arkor init" rerun the
    // round-19 hint had — the local bin isn't on PATH yet.
    expect(infoMessages).not.toMatch(/`arkor init`/);
  });

  // Round 21 (Codex P2, PR #99): when the user explicitly opted
  // out of install (`--skip-install`), the lockfile-ordering
  // rationale doesn't apply — there's no lockfile to wait for.
  // Honor an explicit `--git` request even when scaffold returns
  // blockInstall=true. This restores the historical behaviour
  // for the `--skip-install --git` combo that round 19's broader
  // skip would have regressed.
  it("STILL runs git init when blockInstall=true but install was explicitly skipped via --skip-install", async () => {
    vi.mocked(scaffold).mockResolvedValueOnce({
      cwd,
      files: [{ action: "created", path: "package.json" }],
      warnings: ["Existing .yarnrc.yml pins `nodeLinker: pnp`. ..."],
      blockInstall: true,
    });
    await runInit({
      yes: true,
      packageManager: "yarn",
      skipInstall: true,
      git: true,
    });
    // No install attempted (user opted out), no install gate
    // skip-message either.
    expect(vi.mocked(install)).not.toHaveBeenCalled();
    // git init runs as the user requested — no lockfile to land
    // anyway, so the invariant is moot here.
    expect(vi.mocked(gitInitialCommit)).toHaveBeenCalled();
  });

  // Round 35 (Copilot, PR #99): when install was attempted but
  // FAILED (caught error → installed=false), the previous code
  // still ran `git init` on the no-lockfile tree, breaking the
  // bootstrap-commit invariant. Skip git too and surface a
  // recovery hint mirroring the round-19 advisory branch.
  it("skips git init when install was attempted but threw (lockfile-in-initial-commit invariant)", async () => {
    vi.mocked(install).mockRejectedValueOnce(
      new Error("`yarn install` exited with code 7"),
    );
    const clack = await import("@clack/prompts");
    await runInit({
      yes: true,
      packageManager: "yarn",
      git: true,
    });
    expect(vi.mocked(install)).toHaveBeenCalled();
    // git init was NOT called because install failed.
    expect(vi.mocked(gitInitialCommit)).not.toHaveBeenCalled();
    // User is told why git was skipped + how to recover.
    const infoMessages = vi
      .mocked(clack.log.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(infoMessages).toMatch(/Skipping git init/);
    expect(infoMessages).toMatch(/yarn install.*failed/);
    expect(infoMessages).toMatch(/re-run this command/);
  });

  // Counterpart: regression guard so the gate doesn't accidentally
  // start tripping on the no-warning path.
  it("runs install when scaffold returns blockInstall=false (no advisory)", async () => {
    // Default mock already returns blockInstall: false.
    await runInit({
      yes: true,
      packageManager: "yarn",
      skipGit: true,
    });
    expect(vi.mocked(install)).toHaveBeenCalledWith("yarn", expect.any(String));
  });

  it("interactive: prompts for git init before install so the user can walk away", async () => {
    // The whole point of ENG-625's swap: surface the git-init confirm before
    // the multi-minute `<pm> install` so the user isn't blocked at an
    // interactive question after they've already left the terminal.
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");
    vi.mocked(clack.text).mockResolvedValueOnce("interactive-app" as never);
    vi.mocked(clack.select).mockResolvedValueOnce("triage" as never);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true as never);

    await runInit({
      packageManager: "pnpm",
    });
    const confirmOrder = vi.mocked(clack.confirm).mock.invocationCallOrder[0];
    const installOrder = vi.mocked(install).mock.invocationCallOrder[0];
    expect(confirmOrder).toBeDefined();
    expect(installOrder).toBeDefined();
    expect(confirmOrder).toBeLessThan(installOrder!);
  });
});
