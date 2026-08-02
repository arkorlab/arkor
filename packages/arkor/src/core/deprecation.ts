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
  // Parity with the typed RPC path: `@arkor/cloud-api-client` catches a
  // throwing onDeprecation handler and logs it instead of failing the API
  // call. A deprecation notice is advisory, so a buggy handler must never
  // reject an otherwise-successful chat()/openEventStream() response here
  // either. Two failure shapes to cover: a synchronous throw (the catch),
  // and an ASYNC handler (`(notice) => void` accepts one) whose returned
  // promise rejects, which the sync catch cannot see and which would
  // otherwise become a process-killing unhandled rejection.
  try {
    const result = sink({
      sdkVersion,
      message,
      sunset: res.headers.get("Sunset"),
    }) as unknown;
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result as PromiseLike<unknown>).catch(
        (err: unknown) => {
          swallowSinkError(err);
        },
      );
    }
  } catch (err) {
    swallowSinkError(err);
  }
}

function swallowSinkError(err: unknown): void {
  console.error("[arkor] onDeprecation handler threw; ignoring:", err);
}

export type { DeprecationNotice } from "@arkor/cloud-api-client";
