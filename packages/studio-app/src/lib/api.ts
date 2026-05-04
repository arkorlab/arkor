import { createParser, type EventSourceMessage } from "eventsource-parser";

export interface Credentials {
  token: string;
  mode: "auth0" | "anon";
  baseUrl: string;
  orgSlug: string | null;
  projectSlug: string | null;
}

export interface Me {
  user: Record<string, unknown>;
  orgs: Record<string, unknown>[];
}

export interface Job {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Wire-friendly snapshot of the user's `createArkor({...})` manifest. The
 * Studio backend builds `src/arkor/index.ts` and pulls these fields out so
 * the SPA can show what the project contains without re-importing the
 * artifact itself.
 */
export interface ManifestSummary {
  trainer: { name: string } | null;
  /**
   * Stable hash of the trainer's cloud-side `JobConfig`. The server is
   * always paired with this SPA in the same package, so the field is
   * always present in the wire payload — `null` when no inspectable
   * trainer is loaded, a hex string otherwise. Not optional.
   */
  configHash: string | null;
}

export interface ManifestError {
  error: string;
}

export type ManifestResult = ManifestSummary | ManifestError;

function readStudioToken(): string {
  if (typeof document === "undefined") return "";
  const meta = document.querySelector('meta[name="arkor-studio-token"]');
  return meta?.getAttribute("content") ?? "";
}

const STUDIO_TOKEN = readStudioToken();

/**
 * Whether `arkor dev` wired in an HMR coordinator at server boot.
 * The studio server emits `<meta name="arkor-hmr-enabled" content="true">`
 * into `index.html` only when `options.hmr` is set, so we can tell
 * dev-mode usage from prod-mode usage at runtime — `vite build`'s
 * output ships with `import.meta.env.DEV === false`, so a build-time
 * gate inside the SPA bundle would (wrongly) suppress HMR even in
 * real `arkor dev` sessions. `RunTraining` consults this flag before
 * opening `/api/dev/events`; without it, the EventSource would retry
 * forever against the 404 the server returns for non-HMR builds.
 */
export function isHmrEnabled(): boolean {
  if (typeof document === "undefined") return false;
  const meta = document.querySelector('meta[name="arkor-hmr-enabled"]');
  return meta?.getAttribute("content") === "true";
}

/**
 * `fetch` with the per-launch CSRF token attached. The token is read once at
 * module load from the `<meta>` tag the Studio server injects into
 * `index.html`; cross-origin tabs cannot read it (same-origin policy on the
 * HTML body) so the server's `/api/*` middleware rejects forged requests.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (STUDIO_TOKEN) headers.set("X-Arkor-Studio-Token", STUDIO_TOKEN);
  return fetch(input, { ...init, headers });
}

function withStudioToken(url: string): string {
  if (!STUDIO_TOKEN) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}studioToken=${encodeURIComponent(STUDIO_TOKEN)}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function fetchCredentials(): Promise<Credentials> {
  return json(await apiFetch("/api/credentials"));
}

export async function fetchMe(): Promise<Me> {
  return json(await apiFetch("/api/me"));
}

export async function fetchJobs(): Promise<{ jobs: Job[] }> {
  return json(await apiFetch("/api/jobs"));
}

/**
 * Fetch a serialisable summary of the user's `createArkor({...})` manifest.
 * Returns `{ error }` (not a thrown exception) on 4xx so the SPA can render a
 * targeted hint — typically "no src/arkor/index.ts yet" right after scaffold.
 */
export async function fetchManifest(): Promise<ManifestResult> {
  const res = await apiFetch("/api/manifest");
  if (res.ok) return (await res.json()) as ManifestSummary;
  if (res.status === 400) return (await res.json()) as ManifestError;
  throw new Error(`${res.status} ${res.statusText}`);
}

export function openJobEvents(jobId: string): EventSource {
  // EventSource can't carry custom headers, so the token rides as a query
  // parameter. The Studio server is loopback-only and access logs are local.
  return new EventSource(
    withStudioToken(`/api/jobs/${encodeURIComponent(jobId)}/events`),
  );
}

/**
 * HMR rebuild notifications from `arkor dev`. Server pushes a `ready`
 * event on first bundle, `rebuild` on each subsequent change, and `error`
 * when the bundle fails to compile. `restart: true` indicates a training
 * subprocess was signalled to early-stop and the SPA should re-spawn it
 * after the current `streamTraining` resolves.
 */
export interface DevEvent {
  type: "ready" | "rebuild" | "error";
  outFile?: string;
  hash?: string;
  /** Cloud-side `JobConfig` hash; null when the bundle has no inspectable trainer. */
  configHash?: string | null;
  /** Run name pulled from the rebuilt manifest. */
  trainerName?: string | null;
  message?: string;
  /** True when the rebuild changed cloud-side config and a child was SIGTERM'd. */
  restart?: boolean;
  restartTargets?: Array<{ pid: number; trainFile?: string }>;
  /** True when the rebuild only changed callbacks and one or more children
   *  were SIGUSR2'd to hot-swap their callback closures in place. */
  hotSwap?: boolean;
  hotSwapTargets?: Array<{ pid: number; trainFile?: string }>;
}

export function openDevEvents(): EventSource {
  return new EventSource(withStudioToken("/api/dev/events"));
}

export interface ChatRequestBody {
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  adapter?: { kind: "final" | "checkpoint"; jobId: string; step?: number };
  baseModel?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
}

/**
 * Stream assistant text deltas from `/api/inference/chat`.
 *
 * The Studio server proxies cloud-api's `/v1/inference/chat` SSE stream
 * verbatim, so the body is `event: …\ndata: {…}\n\n` frames — not plain
 * text. We parse the frames with `eventsource-parser` (the same parser
 * the SDK's `iterateEvents` uses) and pull the assistant text out of
 * each frame's `data` payload.
 *
 * Yields the per-frame text fragment so callers can append directly to
 * the assistant message bubble.
 */
export async function* streamInferenceContent(
  body: ChatRequestBody,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await apiFetch("/api/inference/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  // `iterateSseFrames` mirrors cloud-api-client's `iterateEvents` and silently
  // exits when there's no body. That's fine for the SDK but in the Playground
  // it would leave an empty assistant bubble with no error surfaced — make
  // the missing-body case loud here instead.
  if (!res.body) {
    throw new Error("Inference response has no body");
  }

  for await (const sse of iterateSseFrames(res)) {
    if (sse.event === "ping") continue;
    if (sse.event === "end" || sse.data === "[DONE]") return;
    const fragment = extractInferenceDelta(sse.data);
    if (fragment) yield fragment;
  }
}

/**
 * Mirrors `iterateEvents` from `@arkor/cloud-api-client`, inlined here
 * because that package's main entry pulls in Node-only modules and can't
 * be bundled into the SPA. The parser itself (eventsource-parser) is a
 * direct dependency of cloud-api-client, so they stay in sync.
 */
async function* iterateSseFrames(
  response: Response,
): AsyncGenerator<EventSourceMessage> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending: EventSourceMessage[] = [];
  const parser = createParser({
    onEvent(msg) {
      pending.push(msg);
    },
  });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (pending.length > 0) yield pending.shift()!;
    }
    parser.feed(decoder.decode());
    while (pending.length > 0) yield pending.shift()!;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Best-effort extraction of the assistant text fragment from a single SSE
 * frame's `data:` payload. Handles the OpenAI-style streaming envelope
 * (`choices[0].delta.content`) and a couple of reasonable fallbacks. If
 * `data` isn't JSON, surface it as-is so the user still sees *something*
 * instead of silent emptiness.
 *
 * Exported for unit tests; not part of the SPA's public surface.
 */
export function extractInferenceDelta(data: string): string | null {
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  // Some providers/proxies serialize token chunks as plain JSON strings
  // (`data: "Hel"`) rather than objects — surface those directly so we
  // don't end up with a silently empty assistant bubble.
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
    if (delta && typeof delta.content === "string") return delta.content;
  }
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  return null;
}

export async function streamTraining(
  onChunk: (text: string) => void,
  file?: string,
  signal?: AbortSignal,
  /**
   * Called once with the spawned subprocess's pid (or `null` if the
   * server didn't include the `X-Arkor-Train-Pid` header). The SPA
   * uses this to scope HMR `restart` events to the run *this* call
   * actually started, so a passive tab whose own run was hot-swapped
   * doesn't latch onto a sibling tab's restart broadcast.
   */
  onSpawn?: (pid: number | null) => void,
): Promise<void> {
  const res = await apiFetch("/api/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(file ? { file } : {}) }),
    signal,
  });
  if (onSpawn) {
    const raw = res.headers.get("x-arkor-train-pid");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    onSpawn(Number.isFinite(parsed) ? parsed : null);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Cancel the underlying body when the caller aborts so we don't
  // hang on `reader.read()` after the page (and the AbortController
  // cleanup) have moved on.
  const onAbort = () => void reader.cancel().catch(() => {});
  // Cover the case where the signal was already aborted before we
  // got here (or aborted in the small window between `getReader()`
  // and `addEventListener`) — `addEventListener("abort", ...)` won't
  // fire after the fact, so the trainer process spawned upstream
  // would never be killed. Cancel synchronously instead.
  if (signal?.aborted) {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    return;
  }
  signal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    // Flush any bytes the streaming decoder buffered for a multi-byte
    // UTF-8 sequence that landed split across the final two chunks.
    // Without this, the last character of the trainer's output gets
    // silently dropped when it happens to be non-ASCII (Japanese log
    // lines, emoji progress bars, etc.).
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Release the reader lock so a subsequent caller can re-acquire
    // the body if needed. Mirrors `iterateSseFrames`'s finally clause.
    reader.releaseLock();
  }
}
