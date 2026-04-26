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

function readStudioToken(): string {
  if (typeof document === "undefined") return "";
  const meta = document.querySelector('meta[name="arkor-studio-token"]');
  return meta?.getAttribute("content") ?? "";
}

const STUDIO_TOKEN = readStudioToken();

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

export function openJobEvents(jobId: string): EventSource {
  // EventSource can't carry custom headers, so the token rides as a query
  // parameter. The Studio server is loopback-only and access logs are local.
  return new EventSource(
    withStudioToken(`/api/jobs/${encodeURIComponent(jobId)}/events`),
  );
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
): Promise<void> {
  const res = await apiFetch("/api/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(file ? { file } : {}) }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}
