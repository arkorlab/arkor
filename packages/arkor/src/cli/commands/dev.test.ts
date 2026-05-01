import {
  chmodSync,
  existsSync,
  mkdirSync,
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
import {
  readCredentials,
  studioTokenPath,
  writeCredentials,
  type AnonymousCredentials,
} from "../../core/credentials";
import { ensureCredentialsForStudio, runDev } from "./dev";

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
const ORIG_FETCH = globalThis.fetch;
const ORIG_URL = process.env.ARKOR_CLOUD_API_URL;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-dev-test-"));
  process.env.HOME = fakeHome;
  process.env.ARKOR_CLOUD_API_URL = "http://mock-cloud-api";
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
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
  // Setup: pre-create `~/.arkor` and chmod 0o555 (read+exec, no write) so
  // `readCredentials()` cleanly returns null (credentials.json doesn't
  // exist) but `writeCredentials()`'s `writeFile` raises EACCES on the
  // locked-down parent dir. An earlier draft of this test pre-created
  // `~/.arkor/credentials.json` *as a directory*, but that made
  // `readCredentials()` blow up first with EISDIR before the bootstrap
  // logic ever ran — so the assertion accidentally passed for the wrong
  // reason (Copilot review on PR #65).
  //
  // Skipped under UID 0: root bypasses chmod permission checks on Linux,
  // so `writeFile` would succeed and the assertion would never trigger
  // (Codex review on PR #65). Most CI runners are non-root; container-
  // based root CI just loses this one assertion, the wrap-narrowing
  // logic itself is still covered by the schema-validation and 5xx
  // tests above.
  const isRoot =
    typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)("does not rewrite fs errors from writeCredentials as OAuth hints", async () => {
    const arkorDir = join(fakeHome, ".arkor");
    mkdirSync(arkorDir, { recursive: true });
    chmodSync(arkorDir, 0o555);
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

    try {
      await expect(ensureCredentialsForStudio()).rejects.toThrow(/EACCES/);
      await expect(ensureCredentialsForStudio()).rejects.not.toThrow(
        /arkor login --oauth/,
      );
    } finally {
      // Restore writable so the afterEach `rmSync` can clean up.
      chmodSync(arkorDir, 0o755);
    }
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
  // Track exit/signal listeners we add via scheduleStudioTokenCleanup so
  // we can remove them between tests; otherwise vitest's worker would
  // accumulate listeners and Node's MaxListenersExceededWarning would
  // fire by the third test.
  const ORIG_EXIT_LISTENERS = process.listeners("exit").length;
  const ORIG_SIGINT_LISTENERS = process.listeners("SIGINT").length;
  const ORIG_SIGTERM_LISTENERS = process.listeners("SIGTERM").length;
  const ORIG_SIGHUP_LISTENERS = process.listeners("SIGHUP").length;

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
    // Trim the exit/signal listeners runDev installed each iteration to
    // keep vitest's worker tidy across tests.
    const trim = (ev: string, keep: number) => {
      const all = process.listeners(ev as never);
      for (let i = keep; i < all.length; i++) {
        process.removeListener(ev as never, all[i] as never);
      }
    };
    trim("exit", ORIG_EXIT_LISTENERS);
    trim("SIGINT", ORIG_SIGINT_LISTENERS);
    trim("SIGTERM", ORIG_SIGTERM_LISTENERS);
    trim("SIGHUP", ORIG_SIGHUP_LISTENERS);
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
      expect(existsSync(studioTokenPath())).toBe(false);
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
