/**
 * Shared POSIX `128 + signo` exit code mapping for the runner's
 * two-stage shutdown handler (`core/runnerSignals.ts`) and the CLI's
 * cleanup-hook coordinator (`cli/cleanupHooks.ts`). The two map
 * MUST agree: AGENTS.md describes them as a single contract, and a
 * drift (e.g. someone adding SIGQUIT to one but not the other)
 * would make the runner and the dev-server exit with inconsistent
 * codes for the same signal, the exact parent-shell-classification
 * regression the per-signal mapping was introduced to prevent.
 *
 * Lives in `core/` (not `cli/`) so both consumers can import it
 * without `cli/` ↔ `core/` cycles: `cli/cleanupHooks.ts` imports
 * from `core/`, but `core/` must not depend on `cli/`.
 */
export const SIGNAL_EXIT_CODE = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const;

export type ShutdownSignal = keyof typeof SIGNAL_EXIT_CODE;
