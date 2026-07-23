/**
 * A CLI failure whose `message` is already user-facing, actionable copy.
 * `bin.ts` prints `error.message` alone (no stack) and exits 1, so a routine
 * failure (an invalid `--port`, an agent-mode session-file write that failed)
 * never dumps the minified `dist/bin.mjs` code-frame Node would otherwise show
 * at the throw site. Mirrors the `ClaudeCodeStrictExit` contract, except the
 * message is printed by `bin.ts` here rather than pre-written to stderr by the
 * caller.
 */
export class ExpectedCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedCliError";
  }
}
