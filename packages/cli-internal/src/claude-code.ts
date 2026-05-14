import { basename, resolve } from "node:path";
import { sanitise } from "./sanitise";

/**
 * Claude Code (the Anthropic agent CLI) sets `CLAUDECODE=1` in every spawned
 * shell. It cannot answer interactive prompts, and silently falling through to
 * defaults masks decisions the agent should be making explicitly. So the
 * scaffolders (`create-arkor`, `arkor init`) flip into a strict mode under
 * this env var: every flag that mirrors an interactive prompt becomes
 * required, and missing ones produce a stderr message listing the suggested
 * re-invocation rather than running with hidden defaults.
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
 * without falling back to the generic `arkor-project` default. Empty
 * strings, whitespace-only inputs, and strings that contain no
 * `[a-z0-9-]` characters all collapse to `arkor-project` inside
 * `sanitise()`, which is exactly the silent-default outcome strict mode
 * is trying to prevent. The literal `arkor-project` (case-insensitive
 * after trimming) is still accepted because the caller has explicitly
 * asked for that name.
 *
 * `[dir]` is derived through `basename(resolve(opts.dir))` to mirror
 * `create-arkor`'s own default-name derivation. Without `resolve()`,
 * `basename(".")` returns `"."` (which sanitises to the fallback) and
 * the validator would falsely reject explicit invocations like
 * `create-arkor . --template ...` even though the scaffolder would
 * pick up the current directory's name at runtime.
 */
function hasMeaningfulProjectName(opts: ClaudeCodeOptionsCheck): boolean {
  const raw =
    opts.name ?? (opts.dir !== undefined ? basename(resolve(opts.dir)) : undefined);
  if (raw === undefined) return false;
  const sanitised = sanitise(raw);
  if (sanitised !== "arkor-project") return true;
  return raw.trim().toLowerCase() === "arkor-project";
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
        "Project directory (positional) and the `package.json` name. Without `--name`, the basename of `[dir]` is used. Empty / whitespace-only values that `sanitise()` would collapse to the generic `arkor-project` fallback do not count as explicit.",
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
