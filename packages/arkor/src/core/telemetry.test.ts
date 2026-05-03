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
// `os.homedir()` reads USERPROFILE on Windows; HOME-only redirection leaves
// Windows runs writing the telemetry-id under the real user profile.
const ORIG_USERPROFILE = process.env.USERPROFILE;
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
    options?: { longRunning?: boolean },
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
  process.env.USERPROFILE = fakeHome;
  delete process.env.DO_NOT_TRACK;
  delete process.env.ARKOR_TELEMETRY_DISABLED;
  captureMock.mockClear();
  shutdownMock.mockClear();
  constructorMock.mockClear();
});

afterEach(() => {
  // `process.env.X = undefined` writes the literal string "undefined" rather
  // than removing the entry, which then leaks into `os.homedir()` resolution
  // for any test that runs later in the same vitest worker. Match the
  // delete-when-originally-unset pattern used in cli/commands/*.test.ts.
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
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

  it("falls back to telemetry-id when readCredentials throws (malformed JSON)", async () => {
    // `readCredentials` does `JSON.parse` without try/catch; a corrupt
    // credentials.json (e.g. partial write, manually edited) makes it
    // throw. `getIdentity` must catch that and proceed with a freshly
    // generated telemetry-id rather than crashing the whole CLI.
    const dir = join(fakeHome, ".arkor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "{not json");
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id.authMode).toBe("none");
    expect(id.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to telemetry-id when auth0 token has 3 parts but a non-JSON payload", async () => {
    // Branch coverage for the inner try/catch in decodeJwtSub. A token of
    // shape `aaa.bbb.ccc` passes the parts.length===3 guard, then JSON.parse
    // on the decoded base64 throws and the catch returns null.
    writeCreds({
      mode: "auth0",
      accessToken: "header.notvalidjsonbutbase64ish.sig",
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
  });

  it("falls back to telemetry-id when sub is missing or empty in the JWT payload", async () => {
    // Branch coverage for `typeof obj.sub === "string" && obj.sub.length > 0`.
    // Auth0 always issues a sub claim, but a custom IdP that signs through
    // our cloud-api proxy without it must not crash telemetry.
    const header = Buffer.from(JSON.stringify({ alg: "RS256" }))
      .toString("base64url");
    const payload = Buffer.from(JSON.stringify({ aud: "x" }))
      .toString("base64url");
    writeCreds({
      mode: "auth0",
      accessToken: `${header}.${payload}.sig`,
      refreshToken: "rt",
      expiresAt: 0,
      auth0Domain: "d",
      audience: "a",
      clientId: "c",
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id.authMode).toBe("auth0");
    expect(id.distinctId).not.toBe("");
    expect(id.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("regenerates a telemetry-id when the existing file is unreadable (EISDIR)", async () => {
    // Branch coverage for the inner catch in readOrCreateTelemetryId
    // (read-side). A directory at the telemetry-id path makes
    // readFileSync throw EISDIR; the helper falls through to the
    // randomUUID branch and overwrites it.
    const dir = join(fakeHome, ".arkor", "telemetry-id");
    mkdirSync(dir, { recursive: true });
    const mod = await loadTelemetry({ key: "phc_test" });
    const id = await mod.getIdentity();
    expect(id.distinctId).toMatch(/^[0-9a-f-]{36}$/);
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

  it("does not let a thrown PostHog *constructor* error break the CLI (and remembers the failure)", async () => {
    // Branch coverage for the try/catch around `new PostHog(...)`:
    // sets `clientInitFailed = true` so subsequent calls don't re-attempt
    // the failing constructor.
    constructorMock.mockImplementationOnce(() => {
      throw new Error("init blew up");
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await expect(wrapped()).resolves.toBeUndefined();
    // Capture is a no-op when getClient() returned null; the constructor
    // attempt was made (and failed) once.
    expect(constructorMock).toHaveBeenCalledTimes(1);
    expect(captureMock).not.toHaveBeenCalled();

    // A second wrapped call must not re-construct (clientInitFailed
    // short-circuits getClient).
    const wrapped2 = mod.withTelemetry("logout", async () => {});
    await expect(wrapped2()).resolves.toBeUndefined();
    expect(constructorMock).toHaveBeenCalledTimes(1);
  });

  it("emits debug logs to stderr when ARKOR_TELEMETRY_DEBUG is set", async () => {
    // Branch coverage for `debugLog`: gated behind the env flag so it
    // doesn't pollute normal CLI runs.
    process.env.ARKOR_TELEMETRY_DEBUG = "1";
    constructorMock.mockImplementationOnce(() => {
      throw new Error("debug-init-failed");
    });
    const errorChunks: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => {
        errorChunks.push(args.map((a) => String(a)).join(" "));
      });
    try {
      const mod = await loadTelemetry({ key: "phc_test" });
      const wrapped = mod.withTelemetry("whoami", async () => {});
      await wrapped();
    } finally {
      errSpy.mockRestore();
      delete process.env.ARKOR_TELEMETRY_DEBUG;
    }
    expect(errorChunks.some((c) => c.includes("[arkor:telemetry]"))).toBe(
      true,
    );
    expect(errorChunks.some((c) => c.includes("client init failed"))).toBe(
      true,
    );
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

  it("skips cli_command_completed for longRunning commands on success", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry(
      "dev",
      async () => {},
      { longRunning: true },
    );
    await wrapped();
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0].event).toBe("cli_command_started");
  });

  it("does not double-initialise the PostHog client across multiple wrapped calls", async () => {
    // The lazy `getClient` returns the cached instance after the first
    // safeCapture; later calls (started + completed of a 2nd command)
    // must reuse it instead of constructing fresh PostHog instances and
    // leaking sockets across the CLI's lifetime.
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("a", async () => {});
    await wrapped();
    await wrapped();
    expect(constructorMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls.length).toBe(4);
  });

  it("still emits cli_command_failed for longRunning commands that throw during bring-up", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry(
      "dev",
      async () => {
        throw new Error("port in use");
      },
      { longRunning: true },
    );
    await expect(wrapped()).rejects.toThrow("port in use");
    const events = captureMock.mock.calls.map((c) => c[0].event);
    expect(events).toEqual(["cli_command_started", "cli_command_failed"]);
  });

  it("preserves a non-Error thrown value's message via String() coercion", async () => {
    // Codepath sanity: throwing a plain string (or an object literal) must
    // not crash the wrapper before it can emit the failure event.
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("ship", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string-thrown";
    });
    await expect(wrapped()).rejects.toBe("string-thrown");
    const failed = captureMock.mock.calls[1][0];
    expect(failed.properties.error_name).toBe("Error");
    expect(failed.properties.error_message).toBe("string-thrown");
  });
});

describe("shutdownTelemetry", () => {
  it("is a no-op when telemetry never initialised", async () => {
    // Disabled environment never spawns the PostHog client, so shutdown
    // shouldn't try to flush a non-existent transport.
    const mod = await loadTelemetry({ key: "" });
    await expect(mod.shutdownTelemetry()).resolves.toBeUndefined();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("flushes the PostHog client once when initialised", async () => {
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await wrapped();
    expect(constructorMock).toHaveBeenCalledTimes(1);

    await mod.shutdownTelemetry();
    expect(shutdownMock).toHaveBeenCalledTimes(1);

    // Calling again is a no-op: the module-local `client` was cleared.
    await mod.shutdownTelemetry();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("swallows errors thrown by client.shutdown()", async () => {
    shutdownMock.mockImplementationOnce(async () => {
      throw new Error("flush exploded");
    });
    const mod = await loadTelemetry({ key: "phc_test" });
    const wrapped = mod.withTelemetry("whoami", async () => {});
    await wrapped();

    // Must not propagate: shutting down telemetry on CLI exit can never
    // be allowed to mask the actual exit code.
    await expect(mod.shutdownTelemetry()).resolves.toBeUndefined();
  });
});
