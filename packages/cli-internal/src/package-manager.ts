export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/**
 * Infer the package manager from `npm_config_user_agent` (set by the launcher
 * that ran this script). Returns `undefined` when we genuinely can't tell —
 * callers should then ask the user to install deps manually instead of
 * silently guessing.
 */
export function detectPackageManager(): PackageManager | undefined {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  if (ua.startsWith("npm")) return "npm";
  return undefined;
}

export interface PackageManagerFlags {
  useNpm?: boolean;
  usePnpm?: boolean;
  useYarn?: boolean;
  useBun?: boolean;
}

/**
 * Pick a package manager from explicit `--use-*` flags (mutually exclusive)
 * and fall back to the one that invoked the CLI. Returns `undefined` when
 * no flag is set and detection fails.
 */
export function resolvePackageManager(
  flags: PackageManagerFlags = {},
): PackageManager | undefined {
  const selected: PackageManager[] = [];
  if (flags.useNpm) selected.push("npm");
  if (flags.usePnpm) selected.push("pnpm");
  if (flags.useYarn) selected.push("yarn");
  if (flags.useBun) selected.push("bun");
  if (selected.length > 1) {
    throw new Error(
      "Pick one of --use-npm / --use-pnpm / --use-yarn / --use-bun, not several.",
    );
  }
  return selected[0] ?? detectPackageManager();
}
