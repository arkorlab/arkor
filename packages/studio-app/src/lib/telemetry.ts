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

interface State {
  enabled: boolean;
  client: PostHog | null;
  initPromise: Promise<void> | null;
  pending: Array<{ event: string; props?: Props }>;
  globalHandlersInstalled: boolean;
}

const state: State = {
  enabled: false,
  client: null,
  initPromise: null,
  pending: [],
  globalHandlersInstalled: false,
};

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
    const queued = state.pending.splice(0, state.pending.length);
    for (const item of queued) {
      try {
        posthog.capture(item.event, item.props);
      } catch {
        // PostHog errors must never propagate.
      }
    }
  })();
  return state.initPromise;
}

export function track(event: string, props?: Props): void {
  if (!state.enabled) return;
  if (!state.client) {
    state.pending.push({ event, props });
    return;
  }
  try {
    state.client.capture(event, props);
  } catch {
    // swallow
  }
}

export function trackPageView(page: StudioPage): void {
  track("studio_page_viewed", { page });
}

export function captureException(err: unknown, context?: Props): void {
  if (!state.enabled) return;
  const { name, message } = classifyError(err);
  const props: Props = {
    ...(context ?? {}),
    error_name: name,
    error_message: message,
  };
  if (!state.client) {
    state.pending.push({ event: "$exception", props });
    return;
  }
  try {
    if (err instanceof Error) {
      state.client.captureException(err, props);
    } else {
      state.client.capture("$exception", props);
    }
  } catch {
    // swallow
  }
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

// Test-only reset. Not part of the public surface.
export function _resetForTests(): void {
  state.enabled = false;
  state.client = null;
  state.initPromise = null;
  state.pending = [];
  state.globalHandlersInstalled = false;
}
