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
