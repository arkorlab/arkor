/**
 * Single source of truth for the install-matrix's package-manager
 * cases. Both `arkor-init.test.ts` and `create-arkor.test.ts` import
 * `INSTALL_CASES` and `shouldSkipInstallCase` so the matrix layout +
 * skip rules don't drift between the two test files. CI's
 * `.github/workflows/ci.yaml` mirrors the labels in its bash
 * `PM_LABEL` mapping — when adding or removing a case here, update
 * the CI yaml's case statement in lockstep (the comment there points
 * back to this file).
 */

/** Stable label that gates the install case via `ARKOR_E2E_PM`. */
export type InstallCaseLabel =
  | "npm"
  | "pnpm"
  | "yarn"
  | "yarn-berry"
  | "bun";

export interface InstallCase {
  /** Value `ARKOR_E2E_PM` must match for this case to run. */
  label: InstallCaseLabel;
  /** Argument passed as `--use-<flag>` to the SDK / scaffolder. */
  flag: "npm" | "pnpm" | "yarn" | "bun";
  /**
   * When `ARKOR_E2E_PM` is unset (typical local-dev `pnpm test`
   * invocation), run this case only if it's a pm a contributor is
   * expected to have on PATH. yarn / yarn-berry / bun aren't a
   * development prerequisite for arkor itself, so they only fire on
   * CI's install-matrix where the runtime is provisioned beforehand.
   */
  localDefault: boolean;
}

export const INSTALL_CASES: readonly InstallCase[] = [
  { label: "npm",        flag: "npm",  localDefault: true  },
  { label: "pnpm",       flag: "pnpm", localDefault: true  },
  { label: "yarn",       flag: "yarn", localDefault: false },
  // yarn-berry shares the SDK's `--use-yarn` flag; the CI matrix
  // swaps the `yarn` binary in PATH between 1.x (classic) and 4.x
  // (berry).
  { label: "yarn-berry", flag: "yarn", localDefault: false },
  { label: "bun",        flag: "bun",  localDefault: false },
] as const;

const SKIP_INSTALL = process.env.SKIP_E2E_INSTALL === "1";
const E2E_PM = process.env.ARKOR_E2E_PM;

const KNOWN_LABELS: ReadonlySet<string> = new Set(
  INSTALL_CASES.map((c) => c.label),
);

/**
 * Decide whether a given install case should be skipped under the
 * current env. Three layers (in priority order):
 *
 *   - `SKIP_E2E_INSTALL=1` opts out globally (legacy CI fast path).
 *   - `ARKOR_E2E_PM=<label>` runs exactly that case — used by the CI
 *     install-matrix job to provision one pm per runner.
 *   - When `ARKOR_E2E_PM` is unset, only `localDefault` cases run.
 *
 * Throws when `ARKOR_E2E_PM` is set to a label that isn't in
 * `INSTALL_CASES`. Without that guard a typo or a CI-yaml drift (the
 * workflow's `PM_LABEL` mapping is the other half of this contract)
 * would make every case answer `true`, silently turning the
 * install-matrix into a false green — Copilot review on PR #99
 * flagged that as the worst failure mode here.
 */
export function shouldSkipInstallCase(label: InstallCaseLabel): boolean {
  if (SKIP_INSTALL) return true;
  if (E2E_PM !== undefined) {
    if (!KNOWN_LABELS.has(E2E_PM)) {
      throw new Error(
        `ARKOR_E2E_PM="${E2E_PM}" is not one of the install-matrix ` +
          `labels (${[...KNOWN_LABELS].join(", ")}). The CI workflow's ` +
          `PM_LABEL mapping in .github/workflows/ci.yaml has likely ` +
          `drifted from INSTALL_CASES — bring them back in sync ` +
          `before re-running.`,
      );
    }
    return E2E_PM !== label;
  }
  const c = INSTALL_CASES.find((c) => c.label === label);
  return !c?.localDefault;
}
