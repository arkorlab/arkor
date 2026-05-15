import { basename, resolve } from "node:path";

/**
 * Claude Code (the Anthropic agent CLI) sets `CLAUDECODE=1` in every spawned
 * shell. It cannot answer interactive prompts, and silently falling through to
 * defaults masks decisions the agent should be making explicitly. So the
 * scaffolders (`create-arkor`, `arkor init`) flip into a strict mode under
 * this env var: a curated set of flags becomes required, and missing ones
 * produce a stderr message listing the suggested re-invocation rather than
 * running with hidden defaults.
 *
 * "Curated" (not "every interactive prompt") because the runtime defaults
 * for a couple of decisions are well-understood enough that forcing them
 * would just add noise:
 *
 *   - **Project name** is not required by `arkor init`: the scaffolder
 *     derives it from `basename(cwd)`, which is the same value the
 *     interactive prompt offers. `create-arkor` *does* require it because
 *     a missing `[dir]` falls all the way back to the generic
 *     `arkor-project` slug, which is almost always an oversight.
 *   - **Package manager** is not actually prompted for at runtime; it's
 *     a defaulted decision (UA-sniffed, or skipped silently when
 *     detection fails). It's required here because the agent should
 *     pick `--use-*` vs. `--skip-install` deliberately, not because the
 *     interactive UX would have asked.
 *
 * `--yes` opts back into the legacy "accept all defaults" path; callers that
 * have explicitly delegated those decisions to the CLI keep working unchanged.
 */
export function isClaudeCode(): boolean {
  return process.env.CLAUDECODE === "1";
}

/**
 * Thrown by the CLI strict-mode validator after it has already written
 * the human-readable missing-flags block to stderr. The outer bin.ts
 * `catch` recognises this class and exits `1` *without* re-printing the
 * message or its stack; the throw still unwinds through
 * `program.parseAsync()` so the `finally` in `main()` runs (telemetry
 * flush, deprecation notice, etc.), which a bare `process.exit(1)`
 * inside the action handler would have skipped.
 */
export class ClaudeCodeStrictExit extends Error {
  constructor() {
    super("CLAUDECODE strict-mode early exit");
    this.name = "ClaudeCodeStrictExit";
  }
}

export interface ClaudeCodeOptionsCheck {
  /** True when `--yes`/`-y` was passed; bypasses the missing-flag check. */
  yes?: boolean;
  /** Resolved template id, or undefined when `--template` was not passed. */
  template?: string;
  /** True when `--git` was passed. */
  git?: boolean;
  /** True when `--skip-git` was passed. */
  skipGit?: boolean;
  /** True when `--skip-install` was passed. */
  skipInstall?: boolean;
  /** True when any `--use-<pm>` flag was passed. */
  useNpm?: boolean;
  usePnpm?: boolean;
  useYarn?: boolean;
  useBun?: boolean;
  /** Project name (`--name`), or undefined. */
  name?: string;
  /**
   * Positional `[dir]` (create-arkor only). Pass `undefined` for `arkor init`
   * which always operates on `process.cwd()`.
   */
  dir?: string;
  /**
   * `false` only when `--no-agents-md` was passed; `true` when `--agents-md`
   * was passed; `undefined` when neither flag was set. The default-on
   * resolution lives in the CLI action handler.
   */
  agentsMd?: boolean;
  /**
   * Whether the caller wants `[dir]` / `--name` to be required. `arkor init`
   * uses `basename(cwd)` as a meaningful default and sets this to false; the
   * `create-arkor` scaffolder defaults a missing `[dir]` to a generic
   * `arkor-project/` subdirectory and sets this to true so the agent picks a
   * project name deliberately.
   */
  requireProjectName?: boolean;
}

export interface MissingClaudeCodeFlag {
  /** Flag (or flag group) the agent should add to the next invocation. */
  flag: string;
  /** One-sentence explanation of what the flag controls. */
  description: string;
}

/**
 * True when `opts` supplies a project name that survives `sanitise()`
 * without falling back to the generic `arkor-project` default. The
 * fallback only fires when `sanitise()`'s pre-fallback slug is empty,
 * which happens iff the input contains zero `[a-z0-9]` characters
 * (case-insensitive). So an input is "meaningful" iff it has at least
 * one alphanumeric character — this single check captures every silent
 * default we want strict mode to surface (empty strings, whitespace
 * only, punctuation only) without falsely rejecting deliberate names
 * that happen to *sanitise* to `arkor-project` such as `Arkor Project`
 * or `arkor_project`.
 *
 * `[dir]` is derived through `basename(resolve(opts.dir))` to mirror
 * `create-arkor`'s own default-name derivation. Without `resolve()`,
 * `basename(".")` returns `"."` (no alphanumerics) and the validator
 * would falsely reject explicit invocations like
 * `create-arkor . --template ...` even though the scaffolder would
 * pick up the current directory's name at runtime.
 */
function hasMeaningfulProjectName(opts: ClaudeCodeOptionsCheck): boolean {
  if (opts.name !== undefined) return /[a-z0-9]/i.test(opts.name);
  if (opts.dir === undefined) return false;
  // Reject empty / whitespace-only positionals BEFORE resolving them.
  // `resolve("")` (and `resolve("   ")` after trimming through shell
  // word-splitting in practice) returns `process.cwd()`, whose basename
  // is almost always alphanumeric; so without this guard,
  // `create-arkor "" --template ...` or a quoted shell variable that
  // happened to be empty would slip through strict mode and scaffold
  // in-place against the cwd basename, mirroring the silent-default
  // outcome we reject for `--name ""`. `.` / `./` etc. still pass
  // because they are *deliberate* "scaffold in this directory" idioms
  // that share the same runtime semantics as a non-empty path.
  if (opts.dir.trim() === "") return false;
  return /[a-z0-9]/i.test(basename(resolve(opts.dir)));
}

/**
 * Returns the list of missing flags under CLAUDECODE=1, each paired with a
 * short description of what it controls, so the stderr message is
 * self-explanatory and the agent can pick a value without round-tripping to
 * the docs. Empty array means the invocation is fully specified (or `--yes`
 * opted out).
 */
export function missingClaudeCodeFlags(
  opts: ClaudeCodeOptionsCheck,
): MissingClaudeCodeFlag[] {
  if (opts.yes) return [];
  const missing: MissingClaudeCodeFlag[] = [];
  if (opts.requireProjectName && !hasMeaningfulProjectName(opts)) {
    missing.push({
      flag: "[dir] (e.g. `my-arkor-app`) or --name <name>",
      description:
        "Project directory (positional) and the `package.json` name. Without `--name`, the basename of `[dir]` is used. Inputs with no ASCII letter or digit (empty, whitespace-only, or punctuation-only like `!!!` / `***`) are rejected because they would collapse to the generic `arkor-project` fallback inside `sanitise()`.",
    });
  }
  if (opts.template === undefined) {
    missing.push({
      flag: "--template <triage|translate|redaction>",
      description:
        "Starter template: `triage` (support routing), `translate` (9-language translation), or `redaction` (PII removal).",
    });
  }
  if (!opts.git && !opts.skipGit) {
    missing.push({
      flag: "--git (recommended) or --skip-git",
      description:
        "`--git` runs `git init` and creates an initial commit (matches the interactive default); `--skip-git` leaves git setup to the user.",
    });
  }
  const pmFlagSet =
    opts.useNpm || opts.usePnpm || opts.useYarn || opts.useBun || opts.skipInstall;
  if (!pmFlagSet) {
    missing.push({
      flag: "--use-pnpm (or --use-npm / --use-yarn / --use-bun, or --skip-install)",
      description:
        "Which package manager to run `install` with after scaffolding. `--skip-install` leaves the install step to the user.",
    });
  }
  if (opts.agentsMd === undefined) {
    missing.push({
      flag: "--agents-md (recommended) or --no-agents-md",
      description:
        "`--agents-md` writes `AGENTS.md` + `CLAUDE.md` to brief AI coding agents that arkor post-dates their training data (recommended, especially under CLAUDECODE); `--no-agents-md` skips them.",
    });
  }
  return missing;
}

/**
 * Render the stderr block printed when `missingClaudeCodeFlags` returned
 * a non-empty list. Kept as a pure function so both CLIs share the wording
 * and tests can assert on it without invoking the action handler. Each
 * missing flag is rendered on two lines (flag, then indented description)
 * to avoid alignment churn when the longest flag changes.
 */
export function formatClaudeCodeMissingMessage(
  command: string,
  missing: MissingClaudeCodeFlag[],
): string {
  const lines = [
    `${command}: CLAUDECODE=1 detected. Interactive prompts are disabled.`,
    "Re-run with explicit flags:",
  ];
  for (const m of missing) {
    lines.push(`  ${m.flag}`);
    lines.push(`      ${m.description}`);
  }
  lines.push("Or pass -y/--yes to accept all defaults.");
  return `${lines.join("\n")}\n`;
}
