import type { PostHog } from "posthog-js";

export type StudioPage = "home" | "job" | "playground";

export interface StudioTelemetryConfig {
  enabled: boolean;
  distinctId: string;
  authMode: "auth0" | "anon" | "none";
  posthogKey: string;
  posthogHost: string;
  sdkVersion: string;
  debug: boolean;
}

type Props = Record<string, unknown>;

const MESSAGE_MAX = 200;

function truncate(s: string): string {
  return s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX) : s;
}

function classifyError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name || "Error", message: truncate(err.message ?? "") };
  }
  if (typeof err === "string") {
    return { name: "Unknown", message: truncate(err) };
  }
  return { name: "Unknown", message: truncate(String(err ?? "")) };
}

type QueueItem =
  | { kind: "event"; event: string; props?: Props }
  | { kind: "exception"; err: unknown; props: Props };

interface State {
  enabled: boolean;
  client: PostHog | null;
  initPromise: Promise<void> | null;
  pending: QueueItem[];
  globalHandlersInstalled: boolean;
}

// Hard cap on how many pre-init events we keep buffered. If init never runs
// (e.g. /api/credentials returns 403 after a studio token rotation), each
// failing JobsList poll would otherwise grow this queue for the life of the
// tab. 100 is enough to retain a session's startup events; older items are
// dropped FIFO once the cap is hit.
const MAX_PENDING = 100;

const state: State = {
  enabled: false,
  client: null,
  initPromise: null,
  pending: [],
  globalHandlersInstalled: false,
};

// Pre-init events (e.g. the App's mount-time pageview that fires before
// `fetchCredentials()` resolves) must be queued, not dropped. They flush on
// successful init and are discarded if init resolves disabled.
function isDisabledAfterInit(): boolean {
  return state.initPromise !== null && !state.enabled;
}

function pushPending(item: QueueItem): void {
  if (state.pending.length >= MAX_PENDING) state.pending.shift();
  state.pending.push(item);
}

function flushQueue(posthog: PostHog): void {
  const queued = state.pending.splice(0, state.pending.length);
  for (const item of queued) {
    try {
      if (item.kind === "event") {
        posthog.capture(item.event, item.props);
      } else if (item.err instanceof Error) {
        // Forward the original Error so PostHog records the full stack.
        // capture('$exception', props) on a queued plain object would lose it.
        posthog.captureException(item.err, item.props);
      } else {
        posthog.capture("$exception", item.props);
      }
    } catch {
      // PostHog errors must never propagate.
    }
  }
}

export async function initTelemetry(cfg: StudioTelemetryConfig): Promise<void> {
  if (state.initPromise) return state.initPromise;
  if (!cfg.enabled || !cfg.posthogKey) {
    state.enabled = false;
    state.pending = [];
    state.initPromise = Promise.resolve();
    return state.initPromise;
  }
  state.enabled = true;
  state.initPromise = (async () => {
    try {
      const mod = await import("posthog-js");
      const posthog = mod.default;
      posthog.init(cfg.posthogKey, {
        api_host: cfg.posthogHost,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        persistence: "localStorage",
        loaded: (ph) => {
          if (cfg.debug) ph.debug();
        },
      });
      posthog.identify(cfg.distinctId, { auth_mode: cfg.authMode });
      posthog.register({
        sdk_version: cfg.sdkVersion,
        auth_mode: cfg.authMode,
        surface: "studio",
      });
      state.client = posthog;
      installGlobalHandlers();
      flushQueue(posthog);
    } catch (err) {
      // Chunk-load failure, blocked storage, or any other SDK init error:
      // flip back to disabled so subsequent track()/captureException calls
      // stop queueing. Without this, state.enabled stays true forever and
      // state.pending grows unbounded in long-lived sessions.
      state.enabled = false;
      state.pending = [];
      if (cfg.debug && typeof console !== "undefined") {
        console.error("[arkor:studio:telemetry] init failed", err);
      }
    }
  })();
  return state.initPromise;
}

export function track(event: string, props?: Props): void {
  if (state.client) {
    try {
      state.client.capture(event, props);
    } catch {
      // swallow
    }
    return;
  }
  if (isDisabledAfterInit()) return;
  pushPending({ kind: "event", event, props });
}

export function trackPageView(page: StudioPage): void {
  track("studio_page_viewed", { page });
}

export function captureException(err: unknown, context?: Props): void {
  const { name, message } = classifyError(err);
  const props: Props = {
    ...(context ?? {}),
    error_name: name,
    error_message: message,
  };
  if (state.client) {
    try {
      if (err instanceof Error) {
        state.client.captureException(err, props);
      } else {
        state.client.capture("$exception", props);
      }
    } catch {
      // swallow
    }
    return;
  }
  if (isDisabledAfterInit()) return;
  pushPending({ kind: "exception", err, props });
}

/**
 * Tear telemetry down without trying to load posthog-js. Used by App.tsx
 * when the bootstrap call to /api/credentials fails (e.g. stale studio
 * token returns 403): without this, initTelemetry() never runs, every
 * subsequent failing apiFetch keeps queueing studio_api_error events,
 * and the in-memory queue grows for the life of the tab. After this
 * call track()/captureException() drop via isDisabledAfterInit().
 *
 * No-op if init has already started (success or failure path).
 */
export function disableTelemetry(): void {
  if (state.initPromise) return;
  state.enabled = false;
  state.pending = [];
  state.initPromise = Promise.resolve();
}

function installGlobalHandlers(): void {
  if (state.globalHandlersInstalled) return;
  if (typeof window === "undefined") return;
  state.globalHandlersInstalled = true;
  window.addEventListener("unhandledrejection", (e) => {
    captureException(e.reason, { source: "unhandledrejection" });
  });
  window.addEventListener("error", (e) => {
    captureException(e.error ?? e.message, { source: "window_error" });
  });
}
