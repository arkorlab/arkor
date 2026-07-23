import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
      await expect(runDev({ port: 4202, open: true })).resolves.toEqual({
        adopted: false,
      });
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
      await expect(runDev({ port: 4203 })).resolves.toEqual({
        adopted: false,
      });
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
      await expect(runDev({ port: 4208 })).resolves.toEqual({
        adopted: false,
      });
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
      // Agent-facing URL is the 127.0.0.1 literal (matches the bind), not the
      // localhost display name, so a non-Happy-Eyeballs client always reaches it.
      expect(payload.url).toBe("http://127.0.0.1:4310");
      expect(payload.port).toBe(4310);
      expect(payload.pid).toBe(process.pid);
      expect(payload.token).toMatch(/^[\w-]+$/);
      // The home token is still written (user-facing contract: the Vite SPA
      // workflow and the port-collision probe keep working in agent mode).
      expect(readFileSync(studioTokenPath(), "utf8")).toBe(payload.token);
      // Agent mode never opens a browser implicitly.
      expect(open).not.toHaveBeenCalled();
    });

    it("tightens only the agent leaf to 0700 (not the parent .arkor) and writes the file 0600 with no .tmp strays", async () => {
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
      const agentDir = join(projectDir, ".arkor", "agent");
      const dotArkor = join(projectDir, ".arkor");
      expect(statSync(agentDir).mode & 0o777).toBe(0o700);
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
      // The parent .arkor must NOT be forced 0700: it uses the default mode,
      // matching `arkor build`/state.ts. Compare against a control dir created
      // the same way so the assertion is umask-independent.
      mkdirSync(join(projectDir, "control-dir"), { recursive: true });
      expect(statSync(dotArkor).mode & 0o777).toBe(
        statSync(join(projectDir, "control-dir")).mode & 0o777,
      );
      const strays = readdirSync(agentDir).filter((f) => f.includes(".tmp"));
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
      if (process.platform === "win32") {
        // chmod maps to the read-only attribute on Windows, which does not
        // block creating entries inside the directory, so the failure this
        // test injects never happens there.
        return;
      }
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
        // ExpectedCliError (not the raw fs Error) so bin.ts prints the one
        // actionable line without a minified stack; reverting to the raw
        // error must fail here.
        await expect(
          runDev({ port: 4313, agent: true, cwd: projectDir }),
        ).rejects.toMatchObject({
          name: "ExpectedCliError",
          message: expect.stringMatching(/Could not write the agent session/),
        });
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

    it("cleanup removes only this launch's session file (+ its .tmp), never a co-located session sharing this pid", async () => {
      const stdout = await runDevCapturingStdout({
        port: 4315,
        agent: true,
        cwd: projectDir,
      });
      const sessionPath = sessionPathFrom(stdout);
      const dir = join(projectDir, ".arkor", "agent");
      // A co-located session file that happens to share this pid but a
      // different uuid: this is a DIFFERENT live session (real when two
      // containers bind-mount the same project, both running as pid 1). The
      // old pid-prefix sweep deleted it; the exact-path cleanup must not.
      const otherSameP = join(dir, `session-${process.pid}-otheruuid.json`);
      writeFileSync(otherSameP, "{}");
      // A stray .tmp for OUR session path (a signal-mid-write remnant) is ours.
      writeFileSync(`${sessionPath}.tmp`, "{}");

      const cleanup = process.listeners("exit").at(-1) as () => void;
      cleanup();
      expect(existsSync(sessionPath)).toBe(false);
      expect(existsSync(`${sessionPath}.tmp`)).toBe(false);
      // The co-located same-pid session is untouched.
      expect(existsSync(otherSameP)).toBe(true);
    });

    it("does not delete OTHER session files in the agent dir (no pid-liveness sweep)", async () => {
      // A pid-liveness sweep (process.kill) is unsafe when the project dir is
      // a shared bind-mount across containers (pids are namespace-local, so a
      // live foreign session looks dead). Agent startup must therefore leave
      // every other session file untouched and only ever manage its own.
      const dir = join(projectDir, ".arkor", "agent");
      mkdirSync(dir, { recursive: true });
      const foreign = join(dir, `session-999999999-foreign.json`);
      writeFileSync(foreign, "{}");
      const stdout = await runDevCapturingStdout({
        port: 4316,
        agent: true,
        cwd: projectDir,
      });
      const ours = sessionPathFrom(stdout);
      expect(existsSync(ours)).toBe(true);
      // The unrelated file survived: no sweep ran.
      expect(existsSync(foreign)).toBe(true);
    });
  });

  describe("port-collision connect (EADDRINUSE probe)", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "arkor-dev-probe-proj-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

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

    /** Stub the /api/status probe response (JSON body). */
    function mockProbe(
      body: unknown,
      init?: ResponseInit,
    ): ReturnType<typeof vi.fn> {
      const fetchSpy = vi.fn(async () => Response.json(body, init));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      return fetchSpy;
    }

    it("connects to a running Studio serving THIS project: resolves adopted, prints the URL, registers no cleanup, sends no token", async () => {
      mockServeAddrInUse();
      // Occupant reports it is an Arkor Studio serving the same project root.
      const fetchSpy = mockProbe({ server: "arkor-studio", cwd: projectDir });
      const exitBefore = process.listeners("exit").length;
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(runDev({ port: 4320, cwd: projectDir })).resolves.toEqual({
          adopted: true,
        });
        const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(stdout).toContain(
          "Arkor Studio already running on http://localhost:4320",
        );
      } finally {
        stdoutSpy.mockRestore();
      }
      // Probe hit /api/status over 127.0.0.1 (not localhost) with NO token
      // header (the endpoint is token-exempt; nothing is disclosed).
      const [reqUrl, reqInit] = fetchSpy.mock.calls[0] as unknown as [
        URL,
        RequestInit | undefined,
      ];
      expect(String(reqUrl)).toBe("http://127.0.0.1:4320/api/status");
      expect(reqInit?.headers).toBeUndefined();
      // The probe is time-bounded by an AbortSignal (Node fetch has no default
      // timeout): without it, an occupant that accepts TCP but never responds
      // would hang `arkor dev` forever. Assert the signal is passed so removing
      // the timeout guard fails here (the timeout DURATION is exercised
      // behaviorally by the "times out on a silent occupant" test below).
      expect(reqInit?.signal).toBeInstanceOf(AbortSignal);
      // Never follow a redirect from an untrusted occupant (no blind SSRF).
      expect(reqInit?.redirect).toBe("manual");
      // No shutdown handler was registered by this doomed launch.
      expect(process.listeners("exit").length).toBe(exitBefore);
    });

    it("honors --open against the existing instance", async () => {
      mockServeAddrInUse();
      mockProbe({ server: "arkor-studio", cwd: projectDir });
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(
          runDev({ port: 4321, open: true, cwd: projectDir }),
        ).resolves.toEqual({ adopted: true });
      } finally {
        stdoutSpy.mockRestore();
      }
      expect(open).toHaveBeenCalledWith("http://localhost:4321");
    });

    it("adopts when the occupant's cwd is a SYMLINK that realpath-resolves to this project (pins realpathSync)", async () => {
      if (process.platform === "win32") {
        // Symlink creation needs privileges on Windows; the realpath path is
        // exercised on POSIX where the connect flow matters most.
        return;
      }
      mockServeAddrInUse();
      // The occupant reports a DIFFERENT path STRING that resolves to the same
      // real directory. A plain string compare would reject (no adopt); only
      // realpathSync(b.cwd) === realpathSync(projectRoot) matches. Reverting
      // the canonicalization to a string compare makes this test fail.
      const linkPath = `${projectDir}-link`;
      symlinkSync(projectDir, linkPath);
      try {
        mockProbe({ server: "arkor-studio", cwd: linkPath });
        await expect(runDev({ port: 4328, cwd: projectDir })).resolves.toEqual({
          adopted: true,
        });
      } finally {
        rmSync(linkPath, { force: true });
      }
    });

    it("falls back to the port-in-use error when the occupant serves a DIFFERENT project", async () => {
      mockServeAddrInUse();
      // Same-machine Arkor Studio, but a different project root -> do NOT adopt.
      const otherProject = mkdtempSync(join(tmpdir(), "arkor-dev-other-"));
      try {
        mockProbe({ server: "arkor-studio", cwd: otherProject });
        await expect(runDev({ port: 4322, cwd: projectDir })).rejects.toThrow(
          /Port 4322 is already in use/,
        );
      } finally {
        rmSync(otherProject, { recursive: true, force: true });
      }
    });

    it("falls back when the occupant reports a RELATIVE cwd (no `.`-bypass of the project match)", async () => {
      // A hostile occupant returning `cwd: "."` must NOT be adopted. This test
      // is load-bearing only when it reproduces the production invariant
      // `projectRoot === process.cwd()` (since `realpathSync(".")` resolves
      // against the prober's process.cwd()): passing a /tmp `projectDir` here
      // would make the guard untestable (realpathSync(".") != that /tmp path
      // regardless of the guard). So pin projectRoot to process.cwd(): without
      // the `isAbsolute` guard, `realpathSync(".") === realpathSync(cwd)` would
      // wrongly adopt; with it, the launch rejects.
      mockServeAddrInUse();
      mockProbe({ server: "arkor-studio", cwd: "." });
      await expect(runDev({ port: 4327, cwd: process.cwd() })).rejects.toThrow(
        /Port 4327 is already in use/,
      );
    });

    it("falls back when the occupant streams an over-cap body even if it WOULD otherwise match (byte cap)", async () => {
      mockServeAddrInUse();
      // A 200 whose body has the right discriminator + cwd but is > 64 KiB.
      // Only the byte cap can reject it, so this isolates readCapped: with an
      // uncapped `res.json()` the launch would wrongly adopt.
      mockProbe({
        server: "arkor-studio",
        cwd: projectDir,
        filler: "x".repeat(70 * 1024),
      });
      await expect(runDev({ port: 4329, cwd: projectDir })).rejects.toThrow(
        /Port 4329 is already in use/,
      );
    });

    it("falls back on a non-200 even when the body WOULD otherwise match (isolates the res.ok guard)", async () => {
      mockServeAddrInUse();
      // Body has the right discriminator AND a matching cwd, so only the
      // `if (!res.ok) return false` branch can reject it. This keeps the test
      // load-bearing for that guard specifically (a body that also failed the
      // discriminator would pass whether or not the status check existed).
      mockProbe({ server: "arkor-studio", cwd: projectDir }, { status: 404 });
      await expect(runDev({ port: 4323, cwd: projectDir })).rejects.toThrow(
        /Port 4323 is already in use/,
      );
    });

    it("falls back when the probe request itself fails (timeout / refused)", async () => {
      mockServeAddrInUse();
      globalThis.fetch = vi.fn(async () => {
        throw new Error("The operation was aborted due to timeout");
      }) as unknown as typeof fetch;
      await expect(runDev({ port: 4324, cwd: projectDir })).rejects.toThrow(
        /Port 4324 is already in use/,
      );
    });

    it("falls back when the occupant is not an Arkor Studio (missing discriminator)", async () => {
      mockServeAddrInUse();
      mockProbe({ status: "ok", server: "something-else", cwd: projectDir });
      await expect(runDev({ port: 4325, cwd: projectDir })).rejects.toThrow(
        /Port 4325 is already in use/,
      );
    });

    it("agent mode never probes: EADDRINUSE stays a hard error and writes no session file", async () => {
      mockServeAddrInUse();
      const fetchSpy = mockProbe({ server: "arkor-studio", cwd: projectDir });
      await expect(
        runDev({ port: 4326, agent: true, cwd: projectDir }),
      ).rejects.toThrow(/Port 4326 is already in use/);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Bind-first ordering: the session file is written only in the listening
      // callback, so a doomed busy-port launch leaves no `.arkor/agent`.
      expect(existsSync(join(projectDir, ".arkor", "agent"))).toBe(false);
    });

    it("wraps a non-EADDRINUSE pre-bind error (e.g. EACCES on a privileged port) in a clean ExpectedCliError", async () => {
      // parseDevPort now permits 1-1023, so a non-root `arkor dev --port 80`
      // hits EACCES. That must print a clean actionable line, not a minified
      // dist stack, so runDev rejects with an ExpectedCliError.
      vi.mocked(serve).mockImplementationOnce((() => {
        const server = {
          close: vi.fn(),
          on: (event: string, cb: (err: NodeJS.ErrnoException) => void) => {
            if (event === "error") {
              queueMicrotask(() =>
                cb(Object.assign(new Error("bind EACCES"), { code: "EACCES" })),
              );
            }
            return server;
          },
        };
        return server;
      }) as unknown as typeof serve);
      await expect(runDev({ port: 80, cwd: projectDir })).rejects.toMatchObject(
        {
          name: "ExpectedCliError",
          message: expect.stringMatching(/Could not bind port 80:.*EACCES/),
        },
      );
    });

    it("times out and falls back when the occupant accepts the connection but never responds", async () => {
      // Exercises the timeout DURATION, not just that a signal is passed:
      // fetch never resolves and only rejects when the AbortSignal fires.
      // Weakening the guard to an unbounded signal makes this test hang/fail.
      mockServeAddrInUse();
      vi.useFakeTimers();
      globalThis.fetch = vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            // probeExistingStudio catches every throw, so the rejection reason
            // is irrelevant; a plain Error keeps prefer-promise-reject-errors
            // happy. What matters is that ONLY the abort fires it.
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted by AbortSignal.timeout"));
            });
          }),
      ) as unknown as typeof fetch;
      try {
        // Await the rejection inline (Promise.all) while driving the fake
        // clock past 1500ms so AbortSignal.timeout fires and the probe bails.
        await Promise.all([
          expect(runDev({ port: 4332, cwd: projectDir })).rejects.toThrow(
            /Port 4332 is already in use/,
          ),
          vi.advanceTimersByTimeAsync(1600),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts an existing Studio even when first-run credential bootstrap hard-fails (offline)", async () => {
      // Deferred bootstrap: with no credentials AND the config fetch failing,
      // ensureCredentialsForStudio throws, but the adopt path needs no
      // credentials, so a first-run offline launch must still connect.
      rmSync(join(fakeHome, ".arkor", "credentials.json"), { force: true });
      mockServeAddrInUse();
      globalThis.fetch = vi.fn(async (input: unknown) => {
        if (String(input).includes("/api/status")) {
          return Response.json({ server: "arkor-studio", cwd: projectDir });
        }
        throw new TypeError("fetch failed"); // config/anon bootstrap fails
      }) as unknown as typeof fetch;
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(runDev({ port: 4330, cwd: projectDir })).resolves.toEqual({
          adopted: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it("still rejects when bootstrap hard-fails AND this process actually serves", async () => {
      // The deferral only helps the adopt path: if we bind and serve (serving
      // needs credentials), the deferred bootstrap error is surfaced.
      rmSync(join(fakeHome, ".arkor", "credentials.json"), { force: true });
      // Default serve mock fires the listening callback (successful bind).
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await expect(runDev({ port: 4331, cwd: projectDir })).rejects.toThrow(
          /fetch failed/,
        );
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });
});
