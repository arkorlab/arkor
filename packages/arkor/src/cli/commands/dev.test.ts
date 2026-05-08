import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks for the libraries that would otherwise bind a port
// or open a browser when runDev() is exercised end-to-end below.
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));
vi.mock("open", () => ({
  default: vi.fn(async () => undefined),
}));

import { serve } from "@hono/node-server";
import open from "open";
// Re-import the credentials module as a namespace so individual tests can
// `vi.spyOn` on `writeCredentials` to inject deterministic fs failures
// regardless of host OS / filesystem semantics.
import * as credentialsModule from "../../core/credentials";
import {
  readCredentials,
  studioTokenPath,
  writeCredentials,
  type AnonymousCredentials,
} from "../../core/credentials";
import { __resetCleanupHooksForTests } from "../cleanupHooks";
import { ensureCredentialsForStudio, runDev } from "./dev";

/**
 * Yield one `setImmediate` tick — enough for the cleanupHooks
 * coordinator's `Promise.allSettled(...).then(() => process.exit(0))`
 * chain to drain when there are no async cleanups in flight (the
 * common case in this file: signal handler → queueMicrotask →
 * already-resolved `allSettled` → `.then` → `process.exit(0)`,
 * which all collapses into the single macrotask boundary that
 * `setImmediate` yields to).
 *
 * `setImmediate` is the right primitive (vs `Promise.resolve` /
 * `queueMicrotask`) because we need the event loop to actually
 * turn — the `process.exit` mock fires inside a `.then` callback
 * scheduled from a previous microtask checkpoint, and a microtask-
 * only flush would resume *before* that callback gets to run.
 *
 * Tests that drive a chain with extra microtask hops (e.g. async
 * sibling cleanups whose promises also pass through
 * `Promise.allSettled`) await this helper twice in a row — see
 * the cleanupHooks tests.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
// `os.homedir()` reads USERPROFILE on Windows; HOME-only redirection leaves
// Windows runs reading/writing the real user profile and cross-contaminating
// tests via `~/.arkor/credentials.json`.
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_FETCH = globalThis.fetch;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-dev-test-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIG_URL !== undefined) process.env.ARKOR_CLOUD_API_URL = ORIG_URL;
  else delete process.env.ARKOR_CLOUD_API_URL;
  globalThis.fetch = ORIG_FETCH;
  // `vi.spyOn` does not auto-restore between tests in this project's
  // vitest config (no `restoreMocks: true`), so spies on `clack.log.*`
  // would otherwise leak across tests and accumulate call records.
  vi.restoreAllMocks();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("ensureCredentialsForStudio", () => {
  it("returns immediately when credentials already exist", async () => {
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "tok",
      anonymousId: "aid",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-aid",
    };
    await writeCredentials(creds);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(ensureCredentialsForStudio()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readCredentials()).toEqual(creds);
  });

  // When OAuth is advertised by the deployment, `arkor dev` no longer
  // hands off to `runLogin` — that would block the Studio launch on a
  // browser flow. Instead we bootstrap anon and show a hint pointing at
  // `arkor login`, leaving the upgrade in the user's hands.
  it("bootstraps anonymous credentials even when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await ensureCredentialsForStudio();
    expect(await readCredentials()).toMatchObject({
      mode: "anon",
      token: "anon-tok",
    });
  });

  it("bootstraps anonymous credentials when OAuth isn't configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await ensureCredentialsForStudio();
    expect(await readCredentials()).toMatchObject({
      mode: "anon",
      token: "anon-tok",
      anonymousId: "anon-aid",
      orgSlug: "anon-aid",
    });
  });

  // Regression for ENG-403 — when the cloud-api is unreachable, `arkor dev`
  // previously failed to start because the anonymous bootstrap's network
  // error wasn't caught.
  it("does not throw when the anonymous bootstrap fails after a successful config fetch", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).resolves.toBeUndefined();
    expect(await readCredentials()).toBeNull();
  });

  // Codex review on PR #10 (round 3) flagged that swallowing transport
  // failures when fetchCliConfig itself failed is unsafe: on OAuth-only
  // deployments we can't tell from a network outage that /v1/auth/anonymous
  // would have been rejected, and the server-side retry on /api/credentials
  // would just keep failing. So when cfg fetch fails AND the anon attempt
  // also transport-fails, we now fail fast.
  it("re-throws when cloud-api is fully unreachable (deployment mode unknown)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow(TypeError);
    expect(await readCredentials()).toBeNull();
  });

  // Codex review on PR #10 (ENG-403) flagged that the original try/catch
  // swallowed every error, which meant non-transport failures (cloud-api
  // 5xx, schema mismatches, fs errors writing credentials.json) would
  // start Studio in a broken state where `getCredentials()` keeps failing
  // on /api/credentials. Only `TypeError` (undici's fetch transport
  // failure marker) should be swallowed.
  it("re-throws when the cloud-api is reachable but returns non-2xx", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response("internal error", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow(
      /Failed to acquire anonymous token \(500\)/,
    );
    expect(await readCredentials()).toBeNull();
  });

  // Codex review on PR #10 (round 2) flagged that filtering by
  // `instanceof TypeError` alone also swallows config errors (Node's
  // fetch raises `TypeError("Invalid URL")` for malformed
  // ARKOR_CLOUD_API_URL, "URL scheme must be a HTTP(S) scheme" for
  // missing scheme, etc.). Those keep failing on every retry, so they
  // must surface at startup instead of being silently warned.
  it("re-throws when ARKOR_CLOUD_API_URL is malformed (config error)", async () => {
    process.env.ARKOR_CLOUD_API_URL = "";
    // No fetch mock — let real fetch raise the URL parse error so we
    // exercise the actual undici contract, not a synthetic TypeError.
    await expect(ensureCredentialsForStudio()).rejects.toThrow(TypeError);
    await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
      /^fetch failed$/,
    );
    expect(await readCredentials()).toBeNull();
  });

  // Copilot review on PR #65 (round 4) flagged that the wrap originally
  // fired for *all* `AnonymousTokenRejectedError`s including 5xx. A
  // transient cloud-api 500 isn't a sign-in policy decision, so the OAuth
  // hint there would be misleading. The wrap is now gated on 4xx only.
  it("does not rewrite 5xx anon failures as OAuth hints when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response("transient db hiccup", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow(
      /Failed to acquire anonymous token \(503\)/,
    );
    await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
      /arkor login --oauth/,
    );
  });

  // Codex P1 review on PR #65 — OAuth-only deployments advertise Auth0 in
  // /v1/auth/cli/config but reject /v1/auth/anonymous. The new "always try
  // anon first" flow used to leave first-run users on those deployments
  // with a bare "Failed to acquire anonymous token (4xx)" error and no way
  // forward. We now wrap the failure with a pointer at `arkor login --oauth`.
  it("wraps anon-rejected failures with an `arkor login --oauth` hint when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response("anonymous tokens disabled", { status: 403 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow(
      /arkor login --oauth/,
    );
    // Copilot review on PR #65 (round 4) flagged that the wrap used to
    // double-prefix the inner "Failed to acquire anonymous token (...)"
    // message and leak the response-body snippet. Lock in the cleaner
    // top-level form: status code only, full detail on `cause`.
    await expect(ensureCredentialsForStudio()).rejects.toThrow(/HTTP 403/);
    await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
      /anonymous tokens disabled/,
    );
    expect(await readCredentials()).toBeNull();
  });

  // Codex P2 review on PR #65 — the OAuth-only wrap used to span the whole
  // anon bootstrap, so fs errors from `writeCredentials` were also rewritten
  // as "deployment may require sign-in", hiding the actionable fs cause.
  //
  // We inject EACCES at the `writeCredentials` boundary directly via
  // `vi.spyOn` rather than fabricating it from filesystem state. The
  // earlier approach (pre-create `~/.arkor` and `chmod 0o555` so
  // `writeFile` would raise EACCES under the bootstrap) only works on
  // POSIX as a non-root user: root bypasses chmod (Codex on PR #65), and
  // on Windows POSIX permission bits don't durably block writes inside a
  // directory at all — Node maps `chmod` to the legacy read-only
  // attribute, which NTFS only enforces on files. Both edges silently
  // turned the test green for the wrong reason. Mocking lifts the
  // "produce an EACCES" half of the test out of the host filesystem
  // entirely so every CI matrix entry exercises the wrap-narrowing
  // branch.
  it("does not rewrite fs errors from writeCredentials as OAuth hints", async () => {
    const eacces = Object.assign(
      new Error("EACCES: permission denied, open '~/.arkor/credentials.json'"),
      { code: "EACCES" },
    );
    vi.spyOn(credentialsModule, "writeCredentials").mockRejectedValue(eacces);
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow(/EACCES/);
    await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
      /arkor login --oauth/,
    );
  });

  // Copilot review on PR #65 (round 3) flagged that the OAuth-only wrap
  // used to fire on *any* non-transport failure when oauthAvailable=true,
  // including ZodErrors from a malformed cloud-api response. Now that the
  // wrap is gated on `AnonymousTokenRejectedError`, schema-validation
  // failures keep their original message even when OAuth is advertised.
  it("does not rewrite schema-validation errors as OAuth hints when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        // Missing `personalOrg` — anonymousTokenResponseSchema rejects.
        return new Response(
          JSON.stringify({ token: "t", anonymousId: "a", kind: "cli" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
      /arkor login --oauth/,
    );
    expect(await readCredentials()).toBeNull();
  });

  it("forwards a non-Error throwable from requestAnonymousToken (String() coercion)", async () => {
    // Defensive coverage of the `err instanceof Error ? err.message : String(err)`
    // helper inside the warn branch isn't exercised here because the
    // helper is in the dev.ts catch — but the symmetrical path inside
    // the schema-error case rethrows with the original value preserved.
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string-thrown";
    }) as typeof fetch;
    await expect(ensureCredentialsForStudio()).rejects.toBe("string-thrown");
  });

  it("re-throws when the cloud-api responds with a body that fails schema validation", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return new Response(
          JSON.stringify({
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        // Missing `personalOrg` — anonymousTokenResponseSchema rejects.
        return new Response(
          JSON.stringify({ token: "t", anonymousId: "a", kind: "cli" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(ensureCredentialsForStudio()).rejects.toThrow();
    expect(await readCredentials()).toBeNull();
  });

  // Lock down the persistence-nudge gating contract documented in
  // `cli/anonymous.ts`: warn fires only when `oauthAvailable === true`.
  // The id-purpose info line should fire on every successful anon
  // bootstrap regardless of OAuth status.
  describe("anon-issuance output (ANON_PERSISTENCE_NUDGE gating)", () => {
    const okConfigResponse = () =>
      new Response(
        JSON.stringify({
          auth0Domain: "tenant.auth0.com",
          clientId: "client-id",
          audience: "https://api.arkor.ai",
          callbackPorts: [4000],
        }),
        { status: 200 },
      );
    const noOauthConfigResponse = () =>
      new Response(
        JSON.stringify({
          auth0Domain: null,
          clientId: null,
          audience: null,
          callbackPorts: [],
        }),
        { status: 200 },
      );
    const okAnonResponse = () =>
      new Response(
        JSON.stringify({
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        }),
        { status: 200 },
      );

    it("fires the warn when the deployment advertises OAuth", async () => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/cli/config")) return okConfigResponse();
        if (url.endsWith("/v1/auth/anonymous")) return okAnonResponse();
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const infoSpy = vi.spyOn(clack.log, "info");
      const warnSpy = vi.spyOn(clack.log, "warn");

      await ensureCredentialsForStudio();

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Arkor Cloud uses this id"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Anonymous sessions aren't guaranteed to persist",
        ),
      );
    });

    it("suppresses the warn on anon-only deployments", async () => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/cli/config")) return noOauthConfigResponse();
        if (url.endsWith("/v1/auth/anonymous")) return okAnonResponse();
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;
      const infoSpy = vi.spyOn(clack.log, "info");
      const warnSpy = vi.spyOn(clack.log, "warn");

      await ensureCredentialsForStudio();

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Arkor Cloud uses this id"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Anonymous sessions aren't guaranteed to persist",
        ),
      );
    });
  });
});

describe("runDev", () => {
  beforeEach(async () => {
    vi.mocked(serve).mockClear();
    vi.mocked(open).mockClear();
    // Pre-stash credentials so ensureCredentialsForStudio early-returns
    // and we don't need to mock fetch for runDev tests.
    const creds: AnonymousCredentials = {
      mode: "anon",
      token: "tok",
      anonymousId: "aid",
      arkorCloudApiUrl: "http://mock-cloud-api",
      orgSlug: "anon-aid",
    };
    await writeCredentials(creds);
  });

  afterEach(() => {
    // Each `runDev()` arms exit/signal hooks via `registerCleanupHook`.
    // Tests whose handler never fires would leak listeners across the
    // vitest worker's queue; this detaches every still-armed
    // registration so Node's MaxListenersExceededWarning doesn't trip.
    __resetCleanupHooksForTests();
  });

  it("persists the studio token and starts the server on the requested port", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4200 });
    } finally {
      stdoutSpy.mockRestore();
    }
    // Token file lives under the same directory as credentials.json.
    expect(existsSync(studioTokenPath())).toBe(true);
    const contents = readFileSync(studioTokenPath(), "utf8");
    expect(contents).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(serve).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(serve).mock.calls[0]?.[0] as {
      fetch: unknown;
      port: number;
      hostname: string;
    };
    expect(arg.port).toBe(4200);
    expect(arg.hostname).toBe("127.0.0.1");
  });

  it("defaults to port 4000 when --port is omitted", async () => {
    // Branch coverage for `options.port ?? 4000`. serve is mocked so no
    // real bind happens.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev();
    } finally {
      stdoutSpy.mockRestore();
    }
    const arg = vi.mocked(serve).mock.calls[0]?.[0] as { port: number };
    expect(arg.port).toBe(4000);
  });

  it("opens the browser when --open is passed", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4201, open: true });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(open).toHaveBeenCalledWith("http://localhost:4201");
  });

  it("swallows a failure from `open` so the server stays up if the browser is missing", async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error("xdg-open not found"));
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await expect(
        runDev({ port: 4202, open: true }),
      ).resolves.toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("warns but still starts when persisting the studio token fails (read-only HOME)", async () => {
    // Branch coverage for the writeCredentials/persist try/catch. Make
    // ~/.arkor read-only after writeCredentials (so readCredentials still
    // works) so the per-launch token write hits EACCES.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses chmod permission checks — skip on root containers.
      return;
    }
    chmodSync(join(fakeHome, ".arkor"), 0o555);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await expect(runDev({ port: 4203 })).resolves.toBeUndefined();
      expect(serve).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
      // Restore writable for afterEach rmSync.
      chmodSync(join(fakeHome, ".arkor"), 0o755);
    }
  });

  it("registers SIGINT/SIGTERM/SIGHUP handlers that clean up the token + exit", async () => {
    // Branch coverage for scheduleStudioTokenCleanup's signal-handler
    // body (`cleanup(); process.exit(0)`). We invoke each handler
    // synthetically and verify the token file is removed; process.exit
    // is stubbed so the test runner survives.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4205 });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(existsSync(studioTokenPath())).toBe(true);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        // Don't actually exit the worker.
        return undefined as never;
      }) as typeof process.exit);
    try {
      // Pull and fire the most-recently-registered SIGINT handler.
      const sigintListeners = process.listeners("SIGINT");
      const handler = sigintListeners[sigintListeners.length - 1] as () => void;
      handler();
      // Sync side effect (token unlink) lands inside the synchronous
      // portion of the handler.
      expect(existsSync(studioTokenPath())).toBe(false);
      // Exit fires after `Promise.allSettled(asyncCleanups)` resolves —
      // a few microticks later. Flush to let the queued exit run.
      await flushMicrotasks();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("keeps the SIGINT exit handler armed even when persisting the studio token fails", async () => {
    // Regression: if `persistStudioToken` threw, the previous code
    // skipped `scheduleStudioTokenCleanup` — and that was the *only*
    // hook that called `process.exit(0)` on SIGINT. The leftover HMR
    // hook overrides Node's default "exit on SIGINT" behaviour, so the
    // dev server would idle in the foreground forever. The fix
    // registers the token cleanup unconditionally; here we make
    // persist throw and verify SIGINT still terminates.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses chmod permission checks — skip on root containers.
      return;
    }
    chmodSync(join(fakeHome, ".arkor"), 0o555);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4206 });
    } finally {
      stdoutSpy.mockRestore();
      chmodSync(join(fakeHome, ".arkor"), 0o755);
    }

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        return undefined as never;
      }) as typeof process.exit);
    try {
      const sigintListeners = process.listeners("SIGINT");
      const handler = sigintListeners[sigintListeners.length - 1] as () => void;
      handler();
      // Even though the token file was never written, the cleanup hook
      // ran (best-effort `unlinkSync` swallows ENOENT) and the
      // exit-on-signal arm fired (after async cleanup tails settle).
      await flushMicrotasks();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("registers a cleanup listener that removes the studio-token file on exit", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4204 });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(existsSync(studioTokenPath())).toBe(true);

    // Pull the most-recently-registered exit listener and invoke it; that
    // exercises the unlinkSync(path) branch of scheduleStudioTokenCleanup.
    const exitListeners = process.listeners("exit");
    const cleanup = exitListeners[exitListeners.length - 1] as () => void;
    cleanup();
    expect(existsSync(studioTokenPath())).toBe(false);

    // A second invocation must short-circuit (the `cleaned` guard) so it
    // doesn't throw on the now-missing file.
    expect(() => cleanup()).not.toThrow();
  });
});
