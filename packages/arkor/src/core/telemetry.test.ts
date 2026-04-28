import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureMock, shutdownMock, constructorMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  shutdownMock: vi.fn(async () => {}),
  constructorMock: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = captureMock;
    shutdown = shutdownMock;
    constructor(...args: unknown[]) {
      constructorMock(...args);
    }
  },
}));

const ORIG_HOME = process.env.HOME;
const ORIG_DO_NOT_TRACK = process.env.DO_NOT_TRACK;
const ORIG_DISABLED = process.env.ARKOR_TELEMETRY_DISABLED;

let fakeHome: string;

interface TelemetryModule {
  isEnabled: () => boolean;
  getIdentity: () => Promise<{
    distinctId: string;
    authMode: "auth0" | "anon" | "none";
  }>;
  withTelemetry: <TArgs extends unknown[]>(
    command: string,
    handler: (...args: TArgs) => Promise<void>,
  ) => (...args: TArgs) => Promise<void>;
  shutdownTelemetry: () => Promise<void>;
}

async function loadTelemetry(opts: {
  key?: string;
  host?: string;
} = {}): Promise<TelemetryModule> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (opts.key !== undefined) g.__ARKOR_POSTHOG_KEY__ = opts.key;
  else delete g.__ARKOR_POSTHOG_KEY__;
  if (opts.host !== undefined) g.__ARKOR_POSTHOG_HOST__ = opts.host;
  else delete g.__ARKOR_POSTHOG_HOST__;
  vi.resetModules();
  return (await import("./telemetry")) as TelemetryModule;
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-telemetry-test-"));
  process.env.HOME = fakeHome;
  delete process.env.DO_NOT_TRACK;
  delete process.env.ARKOR_TELEMETRY_DISABLED;
  captureMock.mockClear();
  shutdownMock.mockClear();
  constructorMock.mockClear();
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  if (ORIG_DO_NOT_TRACK !== undefined) process.env.DO_NOT_TRACK = ORIG_DO_NOT_TRACK;
  else delete process.env.DO_NOT_TRACK;
  if (ORIG_DISABLED !== undefined) process.env.ARKOR_TELEMETRY_DISABLED = ORIG_DISABLED;
  else delete process.env.ARKOR_TELEMETRY_DISABLED;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("isEnabled", () => {
  it("returns false when DO_NOT_TRACK=1", async () => {
    process.env.DO_NOT_TRACK = "1";
    const mod = await loadTelemetry({ key: "phc_test" });
    expect(mod.isEnabled()).toBe(false);
  });

  it("returns false when ARKOR_TELEMETRY_DISABLED=1", async () => {
    process.env.ARKOR_TELEMETRY_DISABLED = "1";
    const mod = await loadTelemetry({ key: "phc_test" });
    expect(mod.isEnabled()).toBe(false);
  });

  it("returns false when DO_NOT_TRACK is any truthy string", async () => {
    process.env.DO_NOT_TRACK = "true";
    const mod = await loadTelemetry({ key: "phc_test" });
    expect(mod.isEnabled()).toBe(false);
  });

  it("treats DO_NOT_TRACK=0 as disabled flag NOT set", async () => {
    process.env.DO_NOT_TRACK = "0";
    const mod = await loadTelemetry({ key: "phc_test" });
    expect(mod.isEnabled()).toBe(true);
  });

  it("returns false when the build-time PostHog key is empty", async () => {
    const mod = await loadTelemetry({ key: "" });
    expect(mod.isEnabled()).toBe(false);
  });

  it("returns false when the build-time PostHog key is undefined (vitest default)", async () => {
    const mod = await loadTelemetry({});
    expect(mod.isEnabled()).toBe(false);
  });

  it("returns true when key is set and no opt-out flags are present", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    expect(mod.isEnabled()).toBe(true);
  });
});

describe("getIdentity", () => {
  function writeCreds(content: object): void {
    const dir = join(fakeHome, ".arkor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(content));
  }

  it("returns anonymousId for anon credentials", async () => {
    writeCreds({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-xyz",
      arkorCloudApiUrl: "http://localhost",
      orgSlug: "anon-xyz",
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id).toEqual({ distinctId: "anon-xyz", authMode: "anon" });
  });

  it("returns sub for auth0 credentials with a decodable JWT", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const payload = Buffer.from(JSON.stringify({ sub: "auth0|user-123" }))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const accessToken = `${header}.${payload}.signature`;
    writeCreds({
      mode: "auth0",
      accessToken,
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id).toEqual({ distinctId: "auth0|user-123", authMode: "auth0" });
  });

  it("creates and reuses ~/.arkor/telemetry-id when no credentials exist", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const first = await mod.getIdentity();
    expect(first.authMode).toBe("none");
    expect(first.distinctId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const stored = readFileSync(join(fakeHome, ".arkor", "telemetry-id"), "utf8").trim();
    expect(stored).toBe(first.distinctId);

    const second = await mod.getIdentity();
    expect(second.distinctId).toBe(first.distinctId);
  });

  it("falls back to telemetry-id when auth0 token is malformed", async () => {
    writeCreds({
      mode: "auth0",
      accessToken: "not-a-jwt",
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id.authMode).toBe("auth0");
    expect(id.distinctId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(fakeHome, ".arkor", "telemetry-id"))).toBe(true);
  });
});

describe("withTelemetry", () => {
  it("does not initialise the PostHog client when disabled by env var", async () => {
    process.env.DO_NOT_TRACK = "1";
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await wrapped();
    expect(constructorMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("emits started + completed events on success", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await wrapped();
    expect(captureMock).toHaveBeenCalledTimes(2);
    const events = captureMock.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(["cli_command_started", "cli_command_completed"]);
    const completed = captureMock.mock.calls[1][0];
    expect(completed.properties.command).toBe("whoami");
    expect(typeof completed.properties.duration_ms).toBe("number");
    expect(completed.properties.auth_mode).toBe("none");
  });

  it("emits started + failed events and rethrows on error", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("build", async () => {
      throw new Error("boom");
    });
    await expect(wrapped()).rejects.toThrow("boom");
    const events = captureMock.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(["cli_command_started", "cli_command_failed"]);
    const failed = captureMock.mock.calls[1][0];
    expect(failed.properties.error_name).toBe("Error");
    expect(failed.properties.error_message).toBe("boom");
  });

  it("does not let a thrown PostHog error break the CLI", async () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error("network down");
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await expect(wrapped()).resolves.toBeUndefined();
  });

  it("trims overly long error messages", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const longMsg = "x".repeat(500);
    const wrapped = mod.withTelemetry("dev", async () => {
      throw new Error(longMsg);
    });
    await expect(wrapped()).rejects.toThrow();
    const failed = captureMock.mock.calls[1][0];
    expect(failed.properties.error_message.length).toBe(200);
  });
});
