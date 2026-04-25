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
