import type { Credentials } from "../../lib/api";
import { cn } from "../ui/cn";

const PRODUCTION_CLOUD_API_URL = "https://api.arkor.ai";

// Hide the cloud-api URL when pointing at production — regular users don't
// need it. For Arkor contributors running against a local cloud-api
// (`ARKOR_CLOUD_API_URL=...`), surface just the host:port so it's clear which
// backend the Studio is talking to without the protocol noise.
function formatBaseUrl(baseUrl: string): string | null {
  if (baseUrl.replace(/\/$/, "") === PRODUCTION_CLOUD_API_URL) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function IdentityChip({
  creds,
  error,
}: {
  creds: Credentials | null;
  error: string | null;
}) {
  if (error) {
    return (
      <span
        title={error}
        className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300"
      >
        <Dot className="bg-red-500" />
        error
      </span>
    );
  }
  if (!creds) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <Dot className="bg-zinc-400 dark:bg-zinc-500" />
        connecting…
      </span>
    );
  }
  const modeLabel = creds.mode === "auth0" ? "auth0" : "anonymous";
  const baseUrlLabel = formatBaseUrl(creds.baseUrl);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        "border-emerald-200 bg-emerald-50 text-emerald-700",
        "dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300",
      )}
    >
      <Dot className="bg-emerald-500" pulse />
      {modeLabel}
      {baseUrlLabel ? (
        <span className="font-mono text-[10px] text-emerald-700/80 dark:text-emerald-300/80">
          · {baseUrlLabel}
        </span>
      ) : null}
    </span>
  );
}

function Dot({ className, pulse }: { className: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse ? (
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 animate-ping rounded-full opacity-75",
            className,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", className)} />
    </span>
  );
}
