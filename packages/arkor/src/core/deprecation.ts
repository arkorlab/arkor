import type { DeprecationNotice } from "@arkor/cloud-api-client";

let latest: DeprecationNotice | null = null;

/**
 * Record (latest-wins) a deprecation notice observed on an inbound response.
 * Callers from anywhere in the SDK call this; the CLI flushes the result
 * once at the end of `main()` so each invocation prints at most one warning.
 */
export function recordDeprecation(notice: DeprecationNotice): void {
  latest = notice;
}

export function getRecordedDeprecation(): DeprecationNotice | null {
  return latest;
}

export function clearRecordedDeprecation(): void {
  latest = null;
}

/**
 * Inspect a Response for `Deprecation: true` and record the notice. Use this
 * after raw `fetch()` calls that bypass `createClient`'s wrapped fetch
 * (the SSE and chat endpoints in `core/client.ts`, and the studio proxy).
 *
 * `sink` defaults to the SDK-global `recordDeprecation`. Callers with a
 * per-request handler (e.g. `CloudApiClient`'s `onDeprecation` override, which
 * Studio uses to re-emit the notice as proxy headers) pass it here so the raw
 * `chat` / `openEventStream` paths honour the same override the typed RPC
 * client already does, instead of always hitting the global recorder.
 */
export function tapDeprecation(
  res: Response,
  sdkVersion: string,
  sink: (notice: DeprecationNotice) => void = recordDeprecation,
): void {
  if (res.headers.get("Deprecation") !== "true") return;
  const warning = res.headers.get("Warning");
  const message =
    warning?.match(/^\d{3}\s+-\s+"(.+)"\s*$/)?.[1] ??
    warning ??
    `Arkor SDK ${sdkVersion} is deprecated`;
  sink({
    sdkVersion,
    message,
    sunset: res.headers.get("Sunset"),
  });
}

export type { DeprecationNotice } from "@arkor/cloud-api-client";
