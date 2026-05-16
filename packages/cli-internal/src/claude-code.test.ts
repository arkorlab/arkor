import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatClaudeCodeMissingMessage,
  isClaudeCode,
  missingClaudeCodeFlags,
} from "./claude-code";

const ORIG = process.env.CLAUDECODE;

beforeEach(() => {
  delete process.env.CLAUDECODE;
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = ORIG;
});

describe("isClaudeCode", () => {
  it("returns true only when CLAUDECODE === '1'", () => {
    process.env.CLAUDECODE = "1";
    expect(isClaudeCode()).toBe(true);
  });

  it("returns false when CLAUDECODE is unset", () => {
    expect(isClaudeCode()).toBe(false);
  });

  it("returns false for any other value (e.g. 'true', '0', '')", () => {
    // The contract is exact-string match on "1": Claude Code itself
    // sets `CLAUDECODE=1` literally. Loosening this risks accidentally
    // tripping the strict mode for unrelated CI envs that happen to set
    // CLAUDECODE for some other reason.
    for (const v of ["true", "0", "", "yes", "false"]) {
      process.env.CLAUDECODE = v;
      expect(isClaudeCode()).toBe(false);
    }
  });
});

describe("missingClaudeCodeFlags", () => {
  it("returns empty when --yes is set, regardless of other flags", () => {
    expect(missingClaudeCodeFlags({ yes: true })).toEqual([]);
  });

  it("requires --template, --git/--skip-git, a pm flag, and an agents-md flag (init mode)", () => {
    const missing = missingClaudeCodeFlags({ requireProjectName: false });
    expect(missing.map((m) => m.flag)).toEqual([
      "--template <triage|translate|redaction>",
      "--git (recommended) or --skip-git",
      "--use-pnpm (or --use-npm / --use-yarn / --use-bun, or --skip-install)",
      "--agents-md (recommended) or --no-agents-md",
    ]);
    // Every entry pairs the flag with a non-empty description so the
    // stderr block is self-explanatory.
    for (const m of missing) {
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it("additionally requires [dir] / --name when requireProjectName is true (create-arkor mode)", () => {
    const missing = missingClaudeCodeFlags({ requireProjectName: true });
    expect(missing[0]?.flag).toMatch(/\[dir\]/);
  });

  it("[dir] requirement is satisfied by an explicit positional", () => {
    const missing = missingClaudeCodeFlags({
      requireProjectName: true,
      dir: "my-app",
      template: "triage",
      git: true,
      skipInstall: true,
      agentsMd: true,
    });
    expect(missing).toEqual([]);
  });

  it("[dir] requirement is satisfied by --name", () => {
    const missing = missingClaudeCodeFlags({
      requireProjectName: true,
      name: "my-app",
      template: "triage",
      skipGit: true,
      useNpm: true,
      agentsMd: false,
    });
    expect(missing).toEqual([]);
  });

  it("rejects --name values that sanitise() collapses to the `arkor-project` fallback", () => {
    // The strict-mode contract is that the agent commits to a real
    // project name. `--name ""` / `--name "!!!"` / `--name "   "` all
    // pass `sanitise()` through the empty-string fallback path and end
    // up as `arkor-project` in `package.json`, which is exactly the
    // silent default we want to surface.
    for (const name of ["", "   ", "!!!", "***", "@@@"]) {
      const missing = missingClaudeCodeFlags({
        requireProjectName: true,
        name,
        template: "triage",
        skipGit: true,
        useNpm: true,
        agentsMd: false,
      });
      expect(missing.map((m) => m.flag)).toContain(
        "[dir] (e.g. `my-arkor-app`) or --name <name>",
      );
    }
  });

  it("rejects [dir] basenames that sanitise() collapses to the fallback", () => {
    // Same trap via the positional: `create-arkor "   "` would otherwise
    // count as a satisfied project-name requirement even though it
    // also lands on `arkor-project`.
    const missing = missingClaudeCodeFlags({
      requireProjectName: true,
      dir: "!!!",
      template: "triage",
      skipGit: true,
      useNpm: true,
      agentsMd: false,
    });
    expect(missing.map((m) => m.flag)).toContain(
      "[dir] (e.g. `my-arkor-app`) or --name <name>",
    );
  });

  it("rejects empty positional even when --name is set (positional drives the runtime target dir)", () => {
    // PR #141 review (Copilot): `create-arkor` uses `opts.dir` for the
    // *target directory*, not just the slug. So
    // `CLAUDECODE=1 create-arkor "" --name my-app --template ...`
    // would otherwise pass strict mode (because `--name` is meaningful)
    // and then scaffold in-place under the parent dir at runtime via
    // `resolve("")`. The empty-positional guard now fires before the
    // `--name` shortcut so this mis-input is rejected up front.
    const missing = missingClaudeCodeFlags({
      requireProjectName: true,
      dir: "",
      name: "my-app",
      template: "triage",
      skipGit: true,
      useNpm: true,
      agentsMd: false,
    });
    expect(missing.map((m) => m.flag)).toContain(
      "[dir] (e.g. `my-arkor-app`) or --name <name>",
    );
  });

  it.each([
    ["empty positional", ""],
    ["whitespace-only positional", "   "],
    ["tab-only positional", "\t"],
  ])("rejects %s before resolve()", (_label, dir) => {
    // PR #141 review (Copilot): the motivating case is the EMPTY
    // string. `path.resolve("")` returns `process.cwd()` whose
    // basename is usually alphanumeric, so without the trim guard
    // `create-arkor "" --template ...` (or a quoted empty shell
    // variable) would slip through and scaffold against the cwd
    // basename. Whitespace-only inputs would also be rejected by the
    // downstream alphanumeric regex on their own (since
    // `resolve("   ")` keeps the spaces as a basename), but exercising
    // them here pins the guard's contract: trim semantics apply to
    // *every* empty-shaped input, not only `""`. `.` / `./` are
    // covered elsewhere as deliberate "scaffold in this directory"
    // idioms.
    const missing = missingClaudeCodeFlags({
      requireProjectName: true,
      dir,
      template: "triage",
      skipGit: true,
      useNpm: true,
      agentsMd: false,
    });
    expect(missing.map((m) => m.flag)).toContain(
      "[dir] (e.g. `my-arkor-app`) or --name <name>",
    );
  });

  it("resolves [dir] before taking the basename so `.` / `..` are treated like the surrounding directory", () => {
    // Regression for PR #141 review (codex + Copilot): `basename(".")`
    // is `"."` which sanitise() collapses to the fallback, so the
    // previous implementation falsely rejected `create-arkor .
    // --template ...`. Mirroring `basename(resolve(opts.dir))` (what
    // the scaffolder itself uses to derive `defaultName`) makes the
    // strict check agree with the runtime: `.` / `..` resolve to the
    // current / parent directory's basename, and only then are
    // sanitised.
    const baseOpts = {
      requireProjectName: true,
      template: "triage",
      skipGit: true,
      useNpm: true,
      agentsMd: false,
    } as const;
    // `process.cwd()` is the vitest worker's cwd; its basename is
    // some non-empty slug (e.g. `cli-internal` here). The exact value
    // doesn't matter as long as it isn't the `arkor-project` fallback.
    expect(missingClaudeCodeFlags({ ...baseOpts, dir: "." })).toEqual([]);
    expect(missingClaudeCodeFlags({ ...baseOpts, dir: "./" })).toEqual([]);
    // `..` resolves to the parent directory (e.g. `packages` when
    // vitest is run from `packages/cli-internal`), whose basename is
    // also a meaningful slug. Pinning this case matches the test
    // title's claim and guards the symmetric `.` / `..` branch in
    // the `basename(resolve(opts.dir))` derivation.
    expect(missingClaudeCodeFlags({ ...baseOpts, dir: ".." })).toEqual([]);
    // Relative path that resolves to a meaningful basename also passes.
    expect(
      missingClaudeCodeFlags({ ...baseOpts, dir: "foo/bar/my-app" }),
    ).toEqual([]);
  });

  it("accepts deliberate names that happen to sanitise to `arkor-project`", () => {
    // PR #141 review (codex + Copilot): the previous check compared the
    // raw input to the literal `arkor-project` string, so inputs like
    // `Arkor Project`, `arkor_project`, or a `[dir]` basename
    // `Arkor.Project` were rejected because their trimmed/lowercased
    // raw form differed from the sanitised slug. They are deliberate
    // names, not silent defaults; the rewritten check (input contains
    // any `[a-z0-9]`) accepts them because the alphanumeric content
    // proves the user typed a real name. Every entry below sanitises
    // exactly to `arkor-project` (separator rewritten to `-`) which
    // is what makes this test about the *fallback collision*; names
    // with no separator (e.g. `ArkorProject` → `arkorproject`) are
    // covered by the sibling "any alphanumeric content" test so the
    // theme of each test stays honest.
    for (const name of [
      "arkor-project",
      "ARKOR-PROJECT",
      "  arkor-project  ",
      "Arkor Project",
      "arkor_project",
      "Arkor.Project",
    ]) {
      const missing = missingClaudeCodeFlags({
        requireProjectName: true,
        name,
        template: "triage",
        skipGit: true,
        useNpm: true,
        agentsMd: false,
      });
      expect(missing).toEqual([]);
    }
  });

  it("accepts deliberate names whose sanitised slug is unrelated to `arkor-project`", () => {
    // Sibling case to the fallback-collision test above: deliberate
    // names that contain alphanumerics but have no separator (so
    // `sanitise()` lowercases them straight through, producing
    // `arkorproject` etc.) are also accepted. The check is "contains
    // an alphanumeric", not "sanitised slug equals X".
    for (const name of ["ArkorProject", "MyApp", "v2"]) {
      const missing = missingClaudeCodeFlags({
        requireProjectName: true,
        name,
        template: "triage",
        skipGit: true,
        useNpm: true,
        agentsMd: false,
      });
      expect(missing).toEqual([]);
    }
  });

  it("counts --skip-install as satisfying the package-manager requirement", () => {
    const missing = missingClaudeCodeFlags({
      template: "triage",
      git: true,
      skipInstall: true,
      agentsMd: true,
    });
    expect(missing).toEqual([]);
  });

  it("counts --skip-git as satisfying the git requirement", () => {
    const missing = missingClaudeCodeFlags({
      template: "triage",
      skipGit: true,
      usePnpm: true,
      agentsMd: true,
    });
    expect(missing).toEqual([]);
  });

  it("treats --no-agents-md (agentsMd === false) as a valid explicit choice", () => {
    const missing = missingClaudeCodeFlags({
      template: "triage",
      skipGit: true,
      skipInstall: true,
      agentsMd: false,
    });
    expect(missing).toEqual([]);
  });
});

describe("formatClaudeCodeMissingMessage", () => {
  it("renders a stderr block with the command name, every missing flag + description, and the --yes escape hatch", () => {
    const out = formatClaudeCodeMissingMessage("arkor init", [
      {
        flag: "--template <triage|translate|redaction>",
        description: "Pick the starter template.",
      },
      {
        flag: "--git or --skip-git",
        description: "Init a git repo or skip git.",
      },
    ]);
    expect(out).toContain("arkor init: CLAUDECODE=1 detected");
    expect(out).toContain("--template <triage|translate|redaction>");
    expect(out).toContain("Pick the starter template.");
    expect(out).toContain("--git or --skip-git");
    expect(out).toContain("Init a git repo or skip git.");
    expect(out).toContain("-y/--yes");
    expect(out.endsWith("\n")).toBe(true);
  });
});
