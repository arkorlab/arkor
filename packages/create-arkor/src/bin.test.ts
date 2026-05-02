import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the @arkor/cli-internal mock from `arkor`'s init.test.ts —
// keep the helpers cheap (no real fs / install / git) so the focused
// `run()` test below can verify orchestration without spawning real
// CLIs. The scaffold mock returns `warnings: []` by default;
// individual tests override per-call to drive the warning surface.
vi.mock("@arkor/cli-internal", () => ({
  gitInitialCommit: vi.fn(async () => ({ signingFallback: false })),
  install: vi.fn(async () => undefined),
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

import { scaffold } from "@arkor/cli-internal";
import { run } from "./bin";

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
});
