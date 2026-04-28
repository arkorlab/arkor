import type { DeprecationNotice } from "@arkor/cloud-api-client";

export type { DeprecationNotice };

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

/**
 * Inspect a Response for `Deprecation: true` and record the notice. Use this
 * after raw `fetch()` calls that bypass `createClient`'s wrapped fetch
 * (the SSE and chat endpoints in `core/client.ts`, and the studio proxy).
 */
export function tapDeprecation(res: Response, sdkVersion: string): void {
  if (res.headers.get("Deprecation") !== "true") return;
  const warning = res.headers.get("Warning");
  const message =
    warning?.match(/^\d{3}\s+-\s+"(.+)"\s*$/)?.[1] ??
    warning ??
    `Arkor SDK ${sdkVersion} is deprecated`;
  recordDeprecation({
    sdkVersion,
    message,
    sunset: res.headers.get("Sunset"),
  });
}
