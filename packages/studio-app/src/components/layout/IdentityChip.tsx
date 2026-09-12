import { cn } from "../ui/cn";

import type { Credentials } from "../../lib/api";

const PRODUCTION_CLOUD_API_URL = "https://api.arkor.ai";

// Hide the cloud-api URL when pointing at production: regular users don't
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
        className="border-danger-edge bg-danger-surface text-danger-fg inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
      >
        <Dot className="bg-danger" />
        error
      </span>
    );
  }
  if (!creds) {
    return (
      <span className="border-edge-strong text-fg-muted inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-[11px]">
        <Dot className="bg-fg-subtle" />
        connecting…
      </span>
    );
  }
  const modeLabel = creds.mode === "oauth" ? "oauth" : "anonymous";
  const baseUrlLabel = formatBaseUrl(creds.baseUrl);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        "border-edge-strong bg-surface text-fg",
      )}
    >
      <Dot className="bg-fg" pulse />
      {modeLabel}
      {baseUrlLabel ? (
        <span className="text-fg-muted font-mono text-[10px]">
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
      <span
        className={cn(
          "relative inline-flex h-1.5 w-1.5 rounded-full",
          className,
        )}
      />
    </span>
  );
}
