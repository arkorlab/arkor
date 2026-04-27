// Best-effort package-manager detection so the upgrade hint shown to users
// (after a 426 or deprecation warning) reflects what they actually have.
//
// Two signals, in order:
//   1. `npm_config_user_agent` — set when arkor was launched via `npx`,
//      `pnpm exec`, `yarn arkor`, `bunx`. Most reliable when present.
//   2. `process.argv[1]` path — heuristic for globally-installed binaries.
//      pnpm/bun/yarn put their global bin under distinctive directories;
//      everything else falls back to npm.
import { upgradeMessageFromBody } from "@arkor/cloud-api-client";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function detectFromUserAgent(
  ua: string | undefined,
): PackageManager | null {
  if (!ua) return null;
  const product = ua.split("/")[0];
  switch (product) {
    case "pnpm":
    case "yarn":
    case "bun":
    case "npm":
      return product;
    default:
      return null;
  }
}

function detectFromExecPath(argv1: string | undefined): PackageManager | null {
  if (!argv1) return null;
  const path = argv1.replace(/\\/g, "/").toLowerCase();
  if (path.includes("/.bun/")) return "bun";
  if (path.includes("/pnpm/") || path.includes("/.pnpm/")) return "pnpm";
  if (path.includes("/.yarn/") || path.includes("/yarn/")) return "yarn";
  return null;
}

/** Visible for testing; pass explicit signals to avoid touching `process`. */
export function detectPackageManagerFrom(signals: {
  userAgent?: string;
  execPath?: string;
}): PackageManager {
  return (
    detectFromUserAgent(signals.userAgent) ??
    detectFromExecPath(signals.execPath) ??
    "npm"
  );
}

export function detectPackageManager(): PackageManager {
  return detectPackageManagerFrom({
    userAgent: process.env.npm_config_user_agent,
    execPath: process.argv[1],
  });
}

export function upgradeCommandFor(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm add -g arkor@latest";
    case "yarn":
      return "yarn global add arkor@latest";
    case "bun":
      return "bun add -g arkor@latest";
    case "npm":
      return "npm install -g arkor@latest";
  }
}

/** Convenience: detect the current pm and return its global-install command. */
export function detectedUpgradeCommand(): string {
  return upgradeCommandFor(detectPackageManager());
}

/**
 * Format a user-facing message for an HTTP 426 response. Prefers the rich
 * message produced from the gate's structured body; falls back to a generic
 * one-liner when the body is missing, non-JSON, or doesn't match the
 * expected shape — so callers can rely on a non-empty string for **every**
 * 426 instead of guarding on `null` and accidentally falling through to a
 * different code path.
 */
export function formatSdkUpgradeError(body: unknown): string {
  const upgradeCommand = detectedUpgradeCommand();
  const rich = upgradeMessageFromBody(426, body, { upgradeCommand });
  if (rich) return rich;
  return `Arkor SDK is no longer supported by the cloud API. Run \`${upgradeCommand}\`.`;
}
