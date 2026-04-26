import type { Arkor, ArkorInput } from "./types";

/**
 * Build the project's umbrella manifest.
 *
 * `createArkor` is the umbrella factory — it gathers per-role primitives
 * (`trainer`, future: `deploy`, `eval`) under a single value that the CLI
 * (`arkor build` / `arkor start`) and Studio discover from
 * `src/arkor/index.ts`.
 *
 * The returned object is intentionally a frozen, opaque manifest. Operation
 * methods may be added to this shape in the future without breaking the
 * user-facing API; callers should treat the result as a value to hand back to
 * Arkor's tooling, not a programmable client.
 */
export function createArkor(input: ArkorInput): Arkor {
  return Object.freeze({
    _kind: "arkor" as const,
    trainer: input.trainer,
  });
}

/** Type guard used by the CLI runner to discover an Arkor manifest. */
export function isArkor(value: unknown): value is Arkor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _kind?: unknown })._kind === "arkor"
  );
}
