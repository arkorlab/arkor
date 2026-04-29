import { beforeEach, describe, expect, it, vi } from "vitest";

const { initMock, captureMock, captureExceptionMock, identifyMock, registerMock, debugMock } =
  vi.hoisted(() => ({
    initMock: vi.fn(),
    captureMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    identifyMock: vi.fn(),
    registerMock: vi.fn(),
    debugMock: vi.fn(),
  }));

vi.mock("posthog-js", () => {
  const stub = {
    init: initMock,
    capture: captureMock,
    captureException: captureExceptionMock,
    identify: identifyMock,
    register: registerMock,
    debug: debugMock,
  };
  return { default: stub };
});

interface TelemetryModule {
  initTelemetry: (cfg: {
    enabled: boolean;
    distinctId: string;
    authMode: "auth0" | "anon" | "none";
    posthogKey: string;
    posthogHost: string;
    sdkVersion: string;
    debug: boolean;
  }) => Promise<void>;
  track: (event: string, props?: Record<string, unknown>) => void;
  trackPageView: (page: "home" | "job" | "playground") => void;
  captureException: (err: unknown, context?: Record<string, unknown>) => void;
}

async function load(): Promise<TelemetryModule> {
  vi.resetModules();
  return (await import("./telemetry")) as TelemetryModule;
}

const ENABLED_CFG = {
  enabled: true,
  distinctId: "user-1",
  authMode: "anon" as const,
  posthogKey: "phc_test",
  posthogHost: "https://example.posthog.com",
  sdkVersion: "1.2.3",
  debug: false,
};

beforeEach(() => {
  initMock.mockClear();
  captureMock.mockClear();
  captureExceptionMock.mockClear();
  identifyMock.mockClear();
  registerMock.mockClear();
  debugMock.mockClear();
});

describe("initTelemetry (disabled paths)", () => {
  it("does not init posthog when cfg.enabled is false", async () => {
    const mod = await load();
    await mod.initTelemetry({ ...ENABLED_CFG, enabled: false });
    expect(initMock).not.toHaveBeenCalled();
    expect(identifyMock).not.toHaveBeenCalled();
  });

  it("does not init posthog when posthogKey is empty", async () => {
    const mod = await load();
    await mod.initTelemetry({ ...ENABLED_CFG, posthogKey: "" });
    expect(initMock).not.toHaveBeenCalled();
  });

  it("track is a no-op after disabled init", async () => {
    const mod = await load();
    await mod.initTelemetry({ ...ENABLED_CFG, enabled: false });
    mod.track("studio_page_viewed", { page: "home" });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("captureException is a no-op after disabled init", async () => {
    const mod = await load();
    await mod.initTelemetry({ ...ENABLED_CFG, enabled: false });
    mod.captureException(new Error("nope"));
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe("initTelemetry (enabled paths)", () => {
  it("calls posthog.init with autocapture/replay disabled and identifies the user", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    expect(initMock).toHaveBeenCalledTimes(1);
    const [key, opts] = initMock.mock.calls[0];
    expect(key).toBe("phc_test");
    expect(opts.api_host).toBe("https://example.posthog.com");
    expect(opts.autocapture).toBe(false);
    expect(opts.capture_pageview).toBe(false);
    expect(opts.disable_session_recording).toBe(true);
    expect(identifyMock).toHaveBeenCalledWith("user-1", { auth_mode: "anon" });
    expect(registerMock).toHaveBeenCalledWith({
      sdk_version: "1.2.3",
      auth_mode: "anon",
      surface: "studio",
    });
  });

  it("track forwards events to posthog.capture", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    mod.track("studio_train_form_submitted", { has_trainer: true });
    expect(captureMock).toHaveBeenCalledWith("studio_train_form_submitted", {
      has_trainer: true,
    });
  });

  it("trackPageView fires studio_page_viewed with page prop", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    mod.trackPageView("playground");
    expect(captureMock).toHaveBeenCalledWith("studio_page_viewed", {
      page: "playground",
    });
  });

  it("does not throw when posthog.capture throws", async () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error("network");
    });
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    expect(() => mod.track("any")).not.toThrow();
  });
});

describe("captureException", () => {
  it("forwards Error instances to posthog.captureException with truncated message", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    const longMsg = "x".repeat(500);
    mod.captureException(new Error(longMsg), { component: "JobsList" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, props] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(props.error_name).toBe("Error");
    expect(props.error_message.length).toBe(200);
    expect(props.component).toBe("JobsList");
  });

  it("falls back to capture('$exception') for non-Error values", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    mod.captureException("just a string");
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith("$exception", {
      error_name: "Unknown",
      error_message: "just a string",
    });
  });

  it("does not throw when err is undefined", async () => {
    const mod = await load();
    await mod.initTelemetry(ENABLED_CFG);
    expect(() => mod.captureException(undefined)).not.toThrow();
    expect(captureMock).toHaveBeenCalledWith("$exception", {
      error_name: "Unknown",
      error_message: "",
    });
  });
});

describe("queueing", () => {
  it("buffers track() calls fired before init resolves and flushes after", async () => {
    const mod = await load();
    // Start init but do not await; track immediately.
    const initP = mod.initTelemetry(ENABLED_CFG);
    mod.track("studio_page_viewed", { page: "home" });
    expect(captureMock).not.toHaveBeenCalled();
    await initP;
    expect(captureMock).toHaveBeenCalledWith("studio_page_viewed", {
      page: "home",
    });
  });

  it("buffers track() calls fired BEFORE initTelemetry is even called (initial pageview)", async () => {
    // Mirrors the App's mount-time `trackPageView(route.kind)` running before
    // `fetchCredentials()` resolves and calls initTelemetry.
    const mod = await load();
    mod.track("studio_page_viewed", { page: "home" });
    expect(captureMock).not.toHaveBeenCalled();
    await mod.initTelemetry(ENABLED_CFG);
    expect(captureMock).toHaveBeenCalledWith("studio_page_viewed", {
      page: "home",
    });
  });

  it("drops pre-init events when initTelemetry resolves disabled", async () => {
    const mod = await load();
    mod.track("studio_page_viewed", { page: "home" });
    await mod.initTelemetry({ ...ENABLED_CFG, enabled: false });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("preserves Error instances across the queue so flush forwards them to posthog.captureException", async () => {
    // Bug fix: queued exceptions previously flushed via posthog.capture("$exception", props),
    // dropping the original Error reference and the stack trace it carried.
    const mod = await load();
    const err = new Error("boom");
    mod.captureException(err, { source: "react_error_boundary" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
    await mod.initTelemetry(ENABLED_CFG);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [forwardedErr, props] = captureExceptionMock.mock.calls[0];
    expect(forwardedErr).toBe(err);
    expect(props.error_name).toBe("Error");
    expect(props.error_message).toBe("boom");
    expect(props.source).toBe("react_error_boundary");
  });

  it("flushes non-Error queued exceptions via capture('$exception')", async () => {
    const mod = await load();
    mod.captureException("just a string");
    await mod.initTelemetry(ENABLED_CFG);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith("$exception", {
      error_name: "Unknown",
      error_message: "just a string",
    });
  });
});

describe("init failure", () => {
  it("resolves cleanly and drops the queue when posthog.init throws (no unbounded queue)", async () => {
    initMock.mockImplementationOnce(() => {
      throw new Error("blocked storage");
    });
    const mod = await load();
    // Pre-init event would normally queue and flush; with init failure
    // it must be dropped, not retained.
    mod.track("studio_page_viewed", { page: "home" });
    // The init promise itself must NOT reject — telemetry failures should
    // never break callers (App.tsx fire-and-forgets via `void`).
    await expect(mod.initTelemetry(ENABLED_CFG)).resolves.toBeUndefined();
    expect(captureMock).not.toHaveBeenCalled();

    // Subsequent track() / captureException() drop instead of growing the
    // internal queue forever. Verified indirectly: no mock invocations and
    // no thrown errors over many calls.
    for (let i = 0; i < 50; i++) {
      mod.track("studio_train_form_submitted", { i });
      mod.captureException(new Error(`post-failure-${i}`));
    }
    expect(captureMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe("debug flag", () => {
  it("calls posthog.debug when cfg.debug is true via the loaded callback", async () => {
    const mod = await load();
    await mod.initTelemetry({ ...ENABLED_CFG, debug: true });
    const opts = initMock.mock.calls[0][1];
    // Simulate the SDK invoking the loaded callback after init.
    const stub = { debug: debugMock };
    opts.loaded(stub);
    expect(debugMock).toHaveBeenCalledTimes(1);
  });
});
