import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mocks for the libraries that would otherwise bind a port
// or open a browser when runDev() is exercised end-to-end below.
//
// The default `serve` stub simulates a successful async bind: it invokes the
// `listening` callback (2nd arg) so runDev's token-persistence + cleanup
// registration runs, and returns a server object exposing `.on` for the
// error handler. The callback is deferred via queueMicrotask to stay
// faithful to the real timing contract (the real server fires 'listening'
// asynchronously, after runDev has registered its 'error' handler). Tests
// that need EADDRINUSE override it with `mockImplementationOnce`.
vi.mock("@hono/node-server", () => ({
  serve: vi.fn((_opts: unknown, onListen?: () => void) => {
    queueMicrotask(() => onListen?.());
    return { on: vi.fn() };
  }),
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

import { ensureCredentialsForStudio, runDev } from "./dev";

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
  if (ORIG_USERPROFILE !== undefined)
    process.env.USERPROFILE = ORIG_USERPROFILE;
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
  // hands off to `runLogin`: that would block the Studio launch on a
  // browser flow. Instead we bootstrap anon and show a hint pointing at
  // `arkor login`, leaving the upgrade in the user's hands.
  it("bootstraps anonymous credentials even when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return Response.json(
          {
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return Response.json(
          {
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          },
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
        return Response.json(
          {
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return Response.json(
          {
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          },
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

  // Regression for ENG-403: when the cloud-api is unreachable, `arkor dev`
  // previously failed to start because the anonymous bootstrap's network
  // error wasn't caught.
  it("does not throw when the anonymous bootstrap fails after a successful config fetch", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return Response.json(
          {
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          },
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
        return Response.json(
          {
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          },
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
    // No fetch mock: let real fetch raise the URL parse error so we
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
        return Response.json(
          {
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          },
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

  // Codex P1 review on PR #65: OAuth-only deployments advertise Auth0 in
  // /v1/auth/cli/config but reject /v1/auth/anonymous. The new "always try
  // anon first" flow used to leave first-run users on those deployments
  // with a bare "Failed to acquire anonymous token (4xx)" error and no way
  // forward. We now wrap the failure with a pointer at `arkor login --oauth`.
  it("wraps anon-rejected failures with an `arkor login --oauth` hint when OAuth is configured", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return Response.json(
          {
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          },
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

  // Codex P2 review on PR #65: the OAuth-only wrap used to span the whole
  // anon bootstrap, so fs errors from `writeCredentials` were also rewritten
  // as "deployment may require sign-in", hiding the actionable fs cause.
  //
  // We inject EACCES at the `writeCredentials` boundary directly via
  // `vi.spyOn` rather than fabricating it from filesystem state. The
  // earlier approach (pre-create `~/.arkor` and `chmod 0o555` so
  // `writeFile` would raise EACCES under the bootstrap) only works on
  // POSIX as a non-root user: root bypasses chmod (Codex on PR #65), and
  // on Windows POSIX permission bits don't durably block writes inside a
  // directory at all: Node maps `chmod` to the legacy read-only
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
        return Response.json(
          {
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        return Response.json(
          {
            token: "anon-tok",
            anonymousId: "anon-aid",
            kind: "cli",
            personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
          },
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
        return Response.json(
          {
            auth0Domain: "tenant.auth0.com",
            clientId: "client-id",
            audience: "https://api.arkor.ai",
            callbackPorts: [4000],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        // Missing `personalOrg`: anonymousTokenResponseSchema rejects.
        return Response.json(
          { token: "t", anonymousId: "a", kind: "cli" },
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
    // helper is in the dev.ts catch, but the symmetrical path inside
    // the schema-error case rethrows with the original value preserved.
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/config")) {
        return Response.json(
          {
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          },
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
        return Response.json(
          {
            auth0Domain: null,
            clientId: null,
            audience: null,
            callbackPorts: [],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/auth/anonymous")) {
        // Missing `personalOrg`: anonymousTokenResponseSchema rejects.
        return Response.json(
          { token: "t", anonymousId: "a", kind: "cli" },
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
      Response.json(
        {
          auth0Domain: "tenant.auth0.com",
          clientId: "client-id",
          audience: "https://api.arkor.ai",
          callbackPorts: [4000],
        },
        { status: 200 },
      );
    const noOauthConfigResponse = () =>
      Response.json(
        {
          auth0Domain: null,
          clientId: null,
          audience: null,
          callbackPorts: [],
        },
        { status: 200 },
      );
    const okAnonResponse = () =>
      Response.json(
        {
          token: "anon-tok",
          anonymousId: "anon-aid",
          kind: "cli",
          personalOrg: { id: "o", slug: "anon-aid", name: "Anon" },
        },
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
  // Track exit/signal listeners we add via installShutdownHandlers so
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
    expect(contents).toMatch(/^[\w-]+$/);
    // Atomic write (PR #193 review): the temp staging file must be gone.
    const strays = readdirSync(join(fakeHome, ".arkor")).filter((f) =>
      f.includes(".tmp"),
    );
    expect(strays).toEqual([]);

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
      await expect(runDev({ port: 4202, open: true })).resolves.toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("warns but still starts when persisting the studio token fails (read-only HOME)", async () => {
    // Branch coverage for the writeCredentials/persist try/catch. Make
    // ~/.arkor read-only after writeCredentials (so readCredentials still
    // works) so the per-launch token write hits EACCES.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses chmod permission checks; skip on root containers.
      return;
    }
    chmodSync(join(fakeHome, ".arkor"), 0o555);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const sigtermBefore = process.listeners("SIGTERM").length;
      await expect(runDev({ port: 4203 })).resolves.toBeUndefined();
      expect(serve).toHaveBeenCalledTimes(1);
      // Regression (ENG-933 self-review): shutdown handlers must be installed
      // even when token persistence fails, so a SIGTERM (`docker stop`) still
      // routes through `process.exit` and fires 'exit' to reap any train
      // child. Previously they were gated on persistence success.
      expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(
          ((_code?: number) => undefined as never) as typeof process.exit,
        );
      try {
        const handler = process.listeners("SIGTERM").at(-1) as () => void;
        handler();
        expect(exitSpy).toHaveBeenCalledWith(143);
      } finally {
        exitSpy.mockRestore();
      }
    } finally {
      stdoutSpy.mockRestore();
      // Restore writable for afterEach rmSync.
      chmodSync(join(fakeHome, ".arkor"), 0o755);
    }
  });

  it("registers SIGINT/SIGTERM/SIGHUP handlers that clean up the token + exit with the signal's conventional code", async () => {
    // Branch coverage for installShutdownHandlers's signal-handler body
    // (`cleanup(); process.exit(128 + signal)`). We invoke each handler
    // synthetically and verify the token file is removed and the exit code
    // is the conventional `128 + signal number` (so a supervisor can tell
    // the process was signalled, not exited cleanly); process.exit is
    // stubbed so the test runner survives.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4205 });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(existsSync(studioTokenPath())).toBe(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      _code?: number,
    ) => {
      // Don't actually exit the worker.
      return undefined as never;
    }) as typeof process.exit);
    try {
      // SIGINT -> 130, SIGTERM -> 143, SIGHUP -> 129. Token cleanup is
      // idempotent (a shared `cleaned` guard in installShutdownHandlers), so
      // only the FIRST handler invocation below actually unlinks the file;
      // the later iterations verify the per-signal exit codes only.
      for (const [sig, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
        ["SIGHUP", 129],
      ] as const) {
        const listeners = process.listeners(sig);
        const handler = listeners.at(-1) as () => void;
        handler();
        expect(exitSpy).toHaveBeenCalledWith(code);
      }
      // Removed by the first (SIGINT) invocation above.
      expect(existsSync(studioTokenPath())).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });

  // PR #193 review (sentry + coderabbit): once the listener has BOUND, a
  // server 'error' event must be logged, never rejected (reject would kill an
  // already-serving instance during the token-persistence window and is a
  // silent no-op afterwards). Non-Error emissions must not crash the handler.
  it("logs (does not reject) a post-bind server error, including non-Error emissions", async () => {
    let errorCb: ((e: unknown) => void) | undefined;
    vi.mocked(serve).mockImplementationOnce(((
      _opts: unknown,
      onListen?: () => void,
    ) => {
      queueMicrotask(() => onListen?.());
      return {
        on: (event: string, cb: (e: unknown) => void) => {
          if (event === "error") errorCb = cb;
        },
      };
    }) as unknown as typeof serve);
    const warnSpy = vi.spyOn(clack.log, "warn");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await expect(runDev({ port: 4208 })).resolves.toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
    }
    // A live socket fault after startup is logged, not fatal.
    errorCb?.(new Error("EMFILE: too many open files"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Studio server error after startup: EMFILE"),
    );
    // A non-Error emission must not crash the handler either.
    expect(() => errorCb?.("string emission")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("string emission"),
    );
  });

  it("rejects with a clear message on EADDRINUSE without clobbering an existing token or registering cleanup", async () => {
    // A second `arkor dev` on a port already in use must fail on the async
    // 'error' event WITHOUT having persisted (and thus clobbered) a shared
    // studio-token or registered an exit handler that would delete it. The
    // stub below skips the listening callback and fires 'error' instead.
    vi.mocked(serve).mockImplementationOnce((() => {
      const server = {
        on: (event: string, cb: (err: NodeJS.ErrnoException) => void) => {
          if (event === "error") {
            queueMicrotask(() =>
              cb(
                Object.assign(new Error("bind failed"), {
                  code: "EADDRINUSE",
                }),
              ),
            );
          }
          return server;
        },
      };
      return server;
    }) as unknown as typeof serve);

    const exitBefore = process.listeners("exit").length;
    // Seed a token as if a healthy instance owns it: the doomed launch must
    // leave the CONTENT untouched (existence alone can't catch a clobber).
    mkdirSync(join(fakeHome, ".arkor"), { recursive: true });
    writeFileSync(studioTokenPath(), "healthy-instance-token");
    await expect(runDev({ port: 4206 })).rejects.toThrow(
      /Port 4206 is already in use/,
    );
    // The healthy instance's token is untouched and no cleanup handler was
    // registered.
    expect(readFileSync(studioTokenPath(), "utf8")).toBe(
      "healthy-instance-token",
    );
    expect(process.listeners("exit").length).toBe(exitBefore);
  });

  // PR #193 review (coderabbit): the token path is a single shared file, and
  // a second instance on a DIFFERENT port can legitimately overwrite it
  // (last-writer-wins). This instance's shutdown must then leave the file
  // alone: only the current owner's token may be unlinked.
  it("does not unlink a token that another instance has since overwritten", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runDev({ port: 4209 });
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(existsSync(studioTokenPath())).toBe(true);
    // Another instance (different port) overwrites the shared token file.
    writeFileSync(studioTokenPath(), "other-instances-token");
    // Our exit cleanup must notice it no longer owns the file and keep it.
    const cleanup = process.listeners("exit").at(-1) as () => void;
    cleanup();
    expect(existsSync(studioTokenPath())).toBe(true);
    expect(readFileSync(studioTokenPath(), "utf8")).toBe(
      "other-instances-token",
    );
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
    // exercises the unlinkSync(path) branch of installShutdownHandlers.
    const exitListeners = process.listeners("exit");
    const cleanup = exitListeners.at(-1) as () => void;
    cleanup();
    expect(existsSync(studioTokenPath())).toBe(false);

    // A second invocation must short-circuit (the `cleaned` guard) so it
    // doesn't throw on the now-missing file.
    expect(() => cleanup()).not.toThrow();
  });

  describe("agent mode", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "arkor-dev-agent-proj-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    /** Run runDev with a captured stdout and return the joined output. */
    async function runDevCapturingStdout(
      options: Parameters<typeof runDev>[0],
    ): Promise<string> {
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await runDev(options);
        return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      } finally {
        stdoutSpy.mockRestore();
      }
    }

    function sessionPathFrom(stdout: string): string {
      const match = /^Arkor Studio agent session file: (.+)$/m.exec(stdout);
      expect(match).not.toBeNull();
      return match![1];
    }

    it("writes the session file, prints the three-line contract, and still persists the home token", async () => {
      const stdout = await runDevCapturingStdout({
        port: 4310,
        agent: true,
        cwd: projectDir,
      });
      expect(stdout).toContain("Arkor Studio running on http://localhost:4310");
      const sessionPath = sessionPathFrom(stdout);
      expect(stdout).toContain(
        "Read the token from that file and send it as the X-Arkor-Studio-Token header on /api/* requests.",
      );
      // Path shape: <project>/.arkor/agent/session-<pid>-<uuid>.json.
      expect(sessionPath.startsWith(join(projectDir, ".arkor", "agent"))).toBe(
        true,
      );
      expect(sessionPath).toMatch(/session-\d+-[0-9a-f-]+\.json$/);
      const payload = JSON.parse(readFileSync(sessionPath, "utf8")) as {
        token: string;
        url: string;
        port: number;
        pid: number;
      };
      expect(payload.url).toBe("http://localhost:4310");
      expect(payload.port).toBe(4310);
      expect(payload.pid).toBe(process.pid);
      expect(payload.token).toMatch(/^[\w-]+$/);
      // The home token is still written (user-facing contract: the Vite SPA
      // workflow and the port-collision probe keep working in agent mode).
      expect(readFileSync(studioTokenPath(), "utf8")).toBe(payload.token);
      // Agent mode never opens a browser implicitly.
      expect(open).not.toHaveBeenCalled();
    });

    it("creates the directory 0700 and the file 0600 with no .tmp strays", async () => {
      if (process.platform === "win32") {
        // POSIX modes are a no-op on Windows.
        return;
      }
      const stdout = await runDevCapturingStdout({
        port: 4311,
        agent: true,
        cwd: projectDir,
      });
      const sessionPath = sessionPathFrom(stdout);
      const { statSync } = await import("node:fs");
      const dir = join(projectDir, ".arkor", "agent");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
      const strays = readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(strays).toEqual([]);
    });

    it("unlinks the session file from the exit cleanup and on signals", async () => {
      const stdout = await runDevCapturingStdout({
        port: 4312,
        agent: true,
        cwd: projectDir,
      });
      const sessionPath = sessionPathFrom(stdout);
      expect(existsSync(sessionPath)).toBe(true);
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(
          ((_code?: number) => undefined as never) as typeof process.exit,
        );
      try {
        const handler = process.listeners("SIGINT").at(-1) as () => void;
        handler();
        expect(exitSpy).toHaveBeenCalledWith(130);
      } finally {
        exitSpy.mockRestore();
      }
      expect(existsSync(sessionPath)).toBe(false);
      // The home token was ours too, so the same cleanup removed it.
      expect(existsSync(studioTokenPath())).toBe(false);
    });

    it("aborts startup (hard-fail) when the session file cannot be written", async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        // Root bypasses chmod permission checks; skip on root containers.
        return;
      }
      // A read-only <project>/.arkor makes `mkdir .arkor/agent` fail. Unlike
      // the home token (warn-and-continue), agent mode must reject: the
      // session file is the agent's only token channel.
      mkdirSync(join(projectDir, ".arkor"), { recursive: true });
      chmodSync(join(projectDir, ".arkor"), 0o555);
      const closeSpy = vi.fn();
      vi.mocked(serve).mockImplementationOnce(((
        _opts: unknown,
        onListen?: () => void,
      ) => {
        queueMicrotask(() => onListen?.());
        return { on: vi.fn(), close: closeSpy };
      }) as unknown as typeof serve);
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(
          runDev({ port: 4313, agent: true, cwd: projectDir }),
        ).rejects.toThrow();
      } finally {
        stdoutSpy.mockRestore();
        chmodSync(join(projectDir, ".arkor"), 0o755);
      }
      expect(closeSpy).toHaveBeenCalled();
    });

    it("does not create .arkor/agent in normal (non-agent) mode", async () => {
      await runDevCapturingStdout({ port: 4314, cwd: projectDir });
      expect(existsSync(join(projectDir, ".arkor"))).toBe(false);
    });
  });

  describe("port-collision connect (EADDRINUSE probe)", () => {
    /** serve stub that skips the listening callback and fires EADDRINUSE. */
    function mockServeAddrInUse(closeSpy?: () => void): void {
      vi.mocked(serve).mockImplementationOnce((() => {
        const server = {
          close: closeSpy ?? vi.fn(),
          on: (event: string, cb: (err: NodeJS.ErrnoException) => void) => {
            if (event === "error") {
              queueMicrotask(() =>
                cb(
                  Object.assign(new Error("bind failed"), {
                    code: "EADDRINUSE",
                  }),
                ),
              );
            }
            return server;
          },
        };
        return server;
      }) as unknown as typeof serve);
    }

    function seedHomeToken(token: string): void {
      mkdirSync(join(fakeHome, ".arkor"), { recursive: true });
      writeFileSync(studioTokenPath(), token);
    }

    it("connects to a confirmed running Studio: resolves, prints the URL, registers no cleanup", async () => {
      mockServeAddrInUse();
      seedHomeToken("running-instance-token");
      const fetchSpy = vi.fn(async () =>
        Response.json({ status: "ok", server: "arkor-studio" }),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const exitBefore = process.listeners("exit").length;
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(runDev({ port: 4320 })).resolves.toBeUndefined();
        const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(stdout).toContain(
          "Arkor Studio already running on http://localhost:4320",
        );
      } finally {
        stdoutSpy.mockRestore();
      }
      // Probe hit /api/status with the home token in the header.
      const [reqUrl, reqInit] = fetchSpy.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(String(reqUrl)).toBe("http://localhost:4320/api/status");
      expect(
        (reqInit.headers as Record<string, string>)["x-arkor-studio-token"],
      ).toBe("running-instance-token");
      // The running instance's token is untouched and no cleanup handler was
      // registered by this launch.
      expect(readFileSync(studioTokenPath(), "utf8")).toBe(
        "running-instance-token",
      );
      expect(process.listeners("exit").length).toBe(exitBefore);
    });

    it("honors --open against the existing instance", async () => {
      mockServeAddrInUse();
      seedHomeToken("running-instance-token");
      globalThis.fetch = vi.fn(async () =>
        Response.json({ status: "ok", server: "arkor-studio" }),
      ) as unknown as typeof fetch;
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(
          runDev({ port: 4321, open: true }),
        ).resolves.toBeUndefined();
      } finally {
        stdoutSpy.mockRestore();
      }
      expect(open).toHaveBeenCalledWith("http://localhost:4321");
    });

    it("falls back to the port-in-use error when no home token exists (probe skipped)", async () => {
      mockServeAddrInUse();
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      await expect(runDev({ port: 4322 })).rejects.toThrow(
        /Port 4322 is already in use/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("falls back when the occupant rejects the token (403)", async () => {
      mockServeAddrInUse();
      seedHomeToken("stale-token");
      globalThis.fetch = vi.fn(async () =>
        Response.json(
          { error: "Missing or invalid studio token" },
          {
            status: 403,
          },
        ),
      ) as unknown as typeof fetch;
      await expect(runDev({ port: 4323 })).rejects.toThrow(
        /Port 4323 is already in use/,
      );
    });

    it("falls back when the probe request itself fails (timeout / refused)", async () => {
      mockServeAddrInUse();
      seedHomeToken("some-token");
      globalThis.fetch = vi.fn(async () => {
        throw new Error("The operation was aborted due to timeout");
      }) as unknown as typeof fetch;
      await expect(runDev({ port: 4324 })).rejects.toThrow(
        /Port 4324 is already in use/,
      );
    });

    it("falls back when the occupant is not an Arkor Studio (missing discriminator)", async () => {
      mockServeAddrInUse();
      seedHomeToken("some-token");
      globalThis.fetch = vi.fn(async () =>
        Response.json({ status: "ok", server: "something-else" }),
      ) as unknown as typeof fetch;
      await expect(runDev({ port: 4325 })).rejects.toThrow(
        /Port 4325 is already in use/,
      );
    });

    it("agent mode never probes: EADDRINUSE stays a hard error", async () => {
      mockServeAddrInUse();
      seedHomeToken("running-instance-token");
      const fetchSpy = vi.fn(async () =>
        Response.json({ status: "ok", server: "arkor-studio" }),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      await expect(runDev({ port: 4326, agent: true })).rejects.toThrow(
        /Port 4326 is already in use/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
