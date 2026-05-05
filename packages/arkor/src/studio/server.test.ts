import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildStudioApp } from "./server";
import { writeCredentials } from "../core/credentials";
import { writeState } from "../core/state";
import {
  clearRecordedDeprecation,
  getRecordedDeprecation,
} from "../core/deprecation";

const ANON_CREDS = {
  mode: "anon" as const,
  token: "tok",
  anonymousId: "anon-id",
  arkorCloudApiUrl: "http://mock",
  orgSlug: "anon-org",
};

const STUDIO_TOKEN = "test-studio-token-0123456789";

let fakeHome: string;
let assetsDir: string;
let trainCwd: string;
const ORIG_HOME = process.env.HOME;
// `os.homedir()` reads USERPROFILE on Windows; HOME-only redirection leaves
// Windows runs writing test creds to the real user profile and bleeding state
// (e.g. `mode: "anon", token: "tok", orgSlug: "anon-org"`) into other tests
// that read `~/.arkor/credentials.json` and expect it to be absent.
const ORIG_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-studio-test-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  assetsDir = mkdtempSync(join(tmpdir(), "arkor-studio-assets-"));
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    "<!doctype html><html><head><title>Studio</title></head><body></body></html>",
  );
  trainCwd = mkdtempSync(join(tmpdir(), "arkor-studio-cwd-"));
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
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
  rmSync(trainCwd, { recursive: true, force: true });
});

function build() {
  return buildStudioApp({
    baseUrl: "http://mock",
    assetsDir,
    autoAnonymous: false,
    studioToken: STUDIO_TOKEN,
    cwd: trainCwd,
  });
}

describe("Studio server", () => {
  it("requires a studioToken at construction time", () => {
    expect(() =>
      buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        // @ts-expect-error — intentionally omitted to assert the runtime guard
        studioToken: undefined,
      }),
    ).toThrow(/studioToken/);
  });

  it("HTML-escapes special characters in the studio token before injecting", async () => {
    // Branch coverage for `htmlAttrEscape` — a defensive guard against
    // a token that contains `<`, `>`, `&`, `"`, `'`. randomBytes/base64url
    // never produces these, but the helper must still escape them so a
    // future token strategy can't break index.html parsing or open a
    // reflected XSS.
    const exoticToken = "<>&\"'-1234567890ab";
    const app = buildStudioApp({
      baseUrl: "http://mock",
      assetsDir,
      autoAnonymous: false,
      studioToken: exoticToken,
      cwd: trainCwd,
    });
    const res = await app.request("/", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Each special char round-trips as its HTML entity in the meta tag.
    expect(html).toContain(
      '<meta name="arkor-studio-token" content="&lt;&gt;&amp;&quot;&#39;-1234567890ab">',
    );
    // The raw exotic token must not leak into HTML — an attacker who
    // could influence the token (hypothetical) shouldn't be able to
    // inject markup.
    expect(html).not.toMatch(/content="<>/);
  });

  it("serves index.html at / with the studio token injected", async () => {
    const app = build();
    const res = await app.request("/", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Studio</title>");
    expect(html).toContain(
      `<meta name="arkor-studio-token" content="${STUDIO_TOKEN}">`,
    );
    // Injection lands inside <head>, before </head>.
    expect(html.indexOf("arkor-studio-token")).toBeLessThan(
      html.indexOf("</head>"),
    );
  });

  it("serves non-html assets with the correct content-type", async () => {
    // Lines 386-391: the static-file path that bypasses HTML token
    // injection. Drop a JS bundle next to index.html and request it.
    mkdirSync(join(assetsDir, "assets"), { recursive: true });
    writeFileSync(
      join(assetsDir, "assets", "main.js"),
      "console.log('studio')",
    );
    const app = build();
    const res = await app.request("/assets/main.js", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("console.log('studio')");
  });

  it("falls back to index.html for unknown extensionless paths (SPA hash router)", async () => {
    // Lines 404-407: the React app uses a router that produces paths like
    // /jobs/:id which aren't on disk. The handler must serve index.html so
    // the SPA boots, then the client takes over.
    const app = build();
    const res = await app.request("/jobs/some-uuid", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Studio</title>");
  });

  it("returns 404 for unknown paths that look like asset requests", async () => {
    // Distinct from the SPA-fallback case: a missing /assets/missing.js
    // shouldn't silently serve index.html (which the browser would then
    // try to parse as JS and crash on).
    const app = build();
    const res = await app.request("/assets/missing.js", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-loopback static requests without leaking the studio token", async () => {
    const app = build();
    const res = await app.request("/", {
      headers: { host: "evil.example:4000" },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(STUDIO_TOKEN);
    expect(text).not.toContain("arkor-studio-token");
  });

  it("rejects non-loopback API requests (DNS rebinding defense)", async () => {
    const app = build();
    const res = await app.request("/api/credentials", {
      headers: {
        host: "192.168.1.5:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects /api/* without a studio token", async () => {
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-id",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-org",
    });
    const app = build();
    const res = await app.request("/api/credentials", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects /api/* with a wrong studio token", async () => {
    const app = build();
    const res = await app.request("/api/credentials", {
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": "not-the-token",
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns the current credential token when the studio token is valid", async () => {
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-id",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-org",
    });
    const app = build();
    const res = await app.request("/api/credentials", {
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token: "tok",
      mode: "anon",
      baseUrl: "http://mock",
      orgSlug: "anon-org",
    });
  });

  it("rejects ?studioToken= on non-event API requests", async () => {
    const app = build();
    const res = await app.request(
      `/api/credentials?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
      { headers: { host: "127.0.0.1:4000" } },
    );
    expect(res.status).toBe(403);
  });

  it("returns project state from the Studio training cwd", async () => {
    await writeCredentials(ANON_CREDS);
    await writeState(
      {
        orgSlug: "state-org",
        projectSlug: "state-project",
        projectId: "p-state",
      },
      trainCwd,
    );
    const app = build();
    const res = await app.request("/api/credentials", {
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      orgSlug: "state-org",
      projectSlug: "state-project",
    });
  });

  it("accepts the studio token via ?studioToken= for job event streams", async () => {
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-id",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-org",
    });
    const app = build();
    const res = await app.request(
      `/api/jobs/job-1/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
      { headers: { host: "127.0.0.1:4000" } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("No project state");
  });

  it("rejects /api/train with a file path that escapes cwd", async () => {
    // Create the escape target so we exercise the containment check, not the
    // does-not-exist gate added in ENG-404.
    const escapePath = resolve(trainCwd, "../escape.ts");
    writeFileSync(escapePath, "// outside\n");
    try {
      const app = build();
      const res = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ file: "../escape.ts" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/inside the project directory/);
    } finally {
      rmSync(escapePath, { force: true });
    }
  });

  it("rejects /api/train with an absolute file path outside cwd", async () => {
    const app = build();
    const res = await app.request("/api/train", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: "/etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects /api/train when the studio token is only in the query string", async () => {
    const app = build();
    const res = await app.request(
      `/api/train?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "content-type": "text/plain",
        },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
  });

  // Regression for ENG-404 — `path.resolve` doesn't follow symlinks, so a
  // link inside the project directory pointing outside it would previously
  // pass the containment check and be handed to `arkor start` (which would
  // then dlopen the link's target).
  //
  // The link target must be a real existing file: the SDK does
  // `realpath` first and rejects with "file does not exist" if the link
  // dangles, which would short-circuit before the containment check can
  // fire. Earlier this test pointed at `/etc/passwd` and worked on POSIX
  // by coincidence, but Windows has no such path and the dangling-link
  // branch took over. Pointing at a real outside-cwd file keeps both
  // POSIX and Windows runners exercising the containment branch.
  it("rejects /api/train when body.file is a symlink to a path outside cwd", async () => {
    await writeCredentials(ANON_CREDS);
    // Note: GitHub-hosted Windows runners ship with Developer Mode on, so
    // `symlinkSync` works for non-elevated users. If a future image
    // regresses that, we'd rather see the test go red here than silently
    // no-op.
    const outsideDir = mkdtempSync(join(tmpdir(), "arkor-studio-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "secret");
      symlinkSync(outsideFile, join(trainCwd, "evil.ts"));
      const app = build();
      const res = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ file: "evil.ts" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/inside the project directory/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects /api/train when body.file does not exist", async () => {
    await writeCredentials(ANON_CREDS);
    const app = build();
    const res = await app.request("/api/train", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: "missing.ts" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/does not exist/);
  });

  it("rejects /api/train when body.file is a broken symlink", async () => {
    await writeCredentials(ANON_CREDS);
    // Loop symlink: realpath throws ELOOP. Treated like ENOENT.
    symlinkSync(join(trainCwd, "loop.ts"), join(trainCwd, "loop.ts"));
    const app = build();
    const res = await app.request("/api/train", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: "loop.ts" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/does not exist/);
  });

  // Regression for ENG-356 — `/api/train` previously resolved the bundled
  // bin at `<pkg>/bin.mjs` (one level above `dist/`), which never existed.
  // The DI'd `binPath` lets us assert (a) a working bin streams its stdout
  // through the response, and (b) a missing bin surfaces ENOENT-grade errors
  // rather than silently succeeding.
  describe("/api/train spawn (binPath DI)", () => {
    it("streams a real spawn's stdout and exits cleanly when binPath is valid", async () => {
      await writeCredentials(ANON_CREDS);
      const fakeBin = join(trainCwd, "fake-bin.mjs");
      writeFileSync(
        fakeBin,
        `#!/usr/bin/env node
process.stdout.write("[fake-bin] argv=" + JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
      );

      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: fakeBin,
      });
      const res = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("[fake-bin]");
      // The bin receives `start` as the first non-flag arg.
      expect(text).toContain('argv=["start"]');
      expect(text).toContain("exit=0");
      expect(text).not.toMatch(/Cannot find module|MODULE_NOT_FOUND|ENOENT/);
    });

    it("forwards a valid body.file (under trainCwd) to the bin as an extra arg", async () => {
      // Branch coverage for the `trainFile = abs` assignment after the
      // realpath containment check passes. Spawn a fake bin that echoes
      // its argv so we can assert the absolute path was forwarded.
      await writeCredentials(ANON_CREDS);
      const fakeBin = join(trainCwd, "fake-bin.mjs");
      writeFileSync(
        fakeBin,
        `process.stdout.write("[fake-bin] argv=" + JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(0);\n`,
      );
      const targetEntry = join(trainCwd, "src", "arkor", "trainer.ts");
      mkdirSync(join(trainCwd, "src", "arkor"), { recursive: true });
      writeFileSync(targetEntry, "// real trainer source\n");

      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: fakeBin,
      });
      const res = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ file: "src/arkor/trainer.ts" }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // The bin saw `start <abs-resolved-trainer.ts>` as argv. We assert
      // on a path suffix instead of the full absolute path because the
      // server canonicalises through `fs.promises.realpath`, which on
      // macOS / certain Linux temp setups rewrites prefixes (e.g.
      // `/tmp/...` → `/private/tmp/...`); building the expected string
      // with `resolve()` here would mismatch on those hosts.
      const argvMatch = text.match(/argv=(\[[^\]]+\])/);
      expect(argvMatch).not.toBeNull();
      const argv = JSON.parse(argvMatch![1] as string) as string[];
      expect(argv[0]).toBe("start");
      expect(argv[1]).toMatch(/[\\/]src[\\/]arkor[\\/]trainer\.ts$/);
      expect(text).toContain("exit=0");
    });

    it("surfaces ENOENT-grade errors when binPath does not exist", async () => {
      await writeCredentials(ANON_CREDS);
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: join(trainCwd, "definitely-not-a-bin.mjs"),
      });
      const res = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200); // stream opens; the failure shows up in the body
      const text = await res.text();
      expect(text).toMatch(/Cannot find module|MODULE_NOT_FOUND|ENOENT/);
      expect(text).toContain("exit=");
      expect(text).not.toContain("exit=0");
    });
  });

  describe("auto-anonymous bootstrap", () => {
    const ORIG_FETCH = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("acquires + persists an anonymous token on the first /api/credentials hit when autoAnonymous=true", async () => {
      // No credentials on disk — buildStudioApp's autoAnonymous default
      // (true) lets the server bootstrap on first hit so a fresh `arkor
      // dev` works even when the up-front bootstrap in dev.ts skipped due
      // to a transient network blip.
      let calls = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/anonymous")) {
          calls++;
          return new Response(
            JSON.stringify({
              token: "lazy-anon",
              anonymousId: "lazy-aid",
              kind: "cli",
              personalOrg: { id: "o", slug: "lazy-aid", name: "Anon" },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      // The shared build() pins autoAnonymous=false; for this branch we
      // need it on (the production default).
      const app = buildStudioApp({
        baseUrl: "http://mock-cloud-api",
        assetsDir,
        autoAnonymous: true,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
      });
      const res = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; mode: string };
      expect(body).toMatchObject({ token: "lazy-anon", mode: "anon" });
      expect(calls).toBe(1);

      // Subsequent calls use the persisted credentials — no re-bootstrap.
      const res2 = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res2.status).toBe(200);
      expect(calls).toBe(1);
    });

    it("rejects with a sign-in hint when autoAnonymous=false and no credentials exist", async () => {
      // Branch coverage for the `if (!autoAnonymous) throw …` path.
      const app = buildStudioApp({
        baseUrl: "http://mock-cloud-api",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
      });
      const res = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      // Hono surfaces the thrown error as a 500 by default.
      expect(res.status).toBe(500);
    });
  });

  describe("/api/me", () => {
    const ORIG_FETCH = globalThis.fetch;

    beforeEach(() => {
      clearRecordedDeprecation();
    });

    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("forwards SDK version metadata and deprecation headers without onDeprecation noise", async () => {
      await writeCredentials(ANON_CREDS);

      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const req = input instanceof Request ? input : null;
        const headers = new Headers(req?.headers);
        if (init?.headers) {
          for (const [key, value] of new Headers(init.headers)) {
            headers.set(key, value);
          }
        }
        capturedHeaders = {};
        for (const [key, value] of headers) {
          capturedHeaders[key.toLowerCase()] = value;
        }
        return new Response(JSON.stringify({ user: { id: "u1" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            Deprecation: "true",
            Warning: '299 - "me endpoint deprecated"',
            Sunset: "Wed, 01 Jan 2030 00:00:00 GMT",
          },
        });
      }) as typeof fetch;

      // The cloud-api-client wrapper around `onDeprecation` synchronously
      // checks `typeof result.then` on the callback's return value; a plain
      // `void` return throws and gets swallowed with a stderr log. The
      // wrapper in `createRpc` returns null to short-circuit that check —
      // assert that no such log fires here.
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const app = build();
        const res = await app.request("/api/me", {
          headers: {
            host: "127.0.0.1:4000",
            "x-arkor-studio-token": STUDIO_TOKEN,
          },
        });

        expect(res.status).toBe(200);
        expect(capturedHeaders["x-arkor-client"]).toMatch(/^arkor\/\S+$/);
        expect(res.headers.get("Deprecation")).toBe("true");
        expect(res.headers.get("Warning")).toContain("me endpoint deprecated");
        expect(res.headers.get("Sunset")).toBe("Wed, 01 Jan 2030 00:00:00 GMT");
        expect(getRecordedDeprecation()?.message).toBe("me endpoint deprecated");
        for (const call of errorSpy.mock.calls) {
          const first = String(call[0] ?? "");
          expect(first).not.toContain("onDeprecation handler threw");
        }
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("/api/jobs", () => {
    const ORIG_FETCH = globalThis.fetch;

    beforeEach(() => {
      // Module-level deprecation state is shared across tests; reset so that
      // a leftover notice from a prior test can't masquerade as a hit here.
      clearRecordedDeprecation();
    });

    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("forwards SDK version metadata and deprecation headers", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        { orgSlug: "anon-org", projectSlug: "jobs-project", projectId: "p-jobs" },
        trainCwd,
      );

      let captured: {
        url: string;
        method: string;
        headers: Record<string, string>;
      } | null = null;

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const req = input instanceof Request ? input : null;
        const headers = new Headers(req?.headers);
        if (init?.headers) {
          for (const [key, value] of new Headers(init.headers)) {
            headers.set(key, value);
          }
        }
        const lowerHeaders: Record<string, string> = {};
        for (const [key, value] of headers) {
          lowerHeaders[key.toLowerCase()] = value;
        }
        captured = {
          url: req ? req.url : input.toString(),
          method: init?.method ?? req?.method ?? "GET",
          headers: lowerHeaders,
        };
        return new Response(JSON.stringify({ jobs: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            Deprecation: "true",
            Warning: '299 - "jobs endpoint deprecated"',
            Sunset: "Wed, 01 Jan 2030 00:00:00 GMT",
          },
        });
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/jobs", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });

      expect(res.status).toBe(200);
      expect(captured).not.toBeNull();
      expect(captured!.url).toContain("/v1/jobs");
      expect(captured!.url).toContain("orgSlug=anon-org");
      expect(captured!.url).toContain("projectSlug=jobs-project");
      expect(captured!.method).toBe("GET");
      expect(captured!.headers.authorization).toBe("Bearer tok");
      expect(captured!.headers["x-arkor-client"]).toMatch(/^arkor\/\S+$/);
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Warning")).toContain("jobs endpoint deprecated");
      expect(res.headers.get("Sunset")).toBe("Wed, 01 Jan 2030 00:00:00 GMT");
      expect(getRecordedDeprecation()?.message).toBe("jobs endpoint deprecated");
    });

    it("uses the Studio training cwd for job event streams", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "events-org",
          projectSlug: "events-project",
          projectId: "p-events",
        },
        trainCwd,
      );

      let capturedUrl: string | null = null;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        _init?: RequestInit,
      ) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response("event: end\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/jobs/job-1/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });

      expect(res.status).toBe(200);
      expect(capturedUrl).not.toBeNull();
      expect(capturedUrl!).toContain("/v1/jobs/job-1/events/stream");
      expect(capturedUrl!).toContain("orgSlug=events-org");
      expect(capturedUrl!).toContain("projectSlug=events-project");
    });

    it("forwards deprecation headers and records the notice for job event streams", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "events-org",
          projectSlug: "events-project",
          projectId: "p-events",
        },
        trainCwd,
      );

      globalThis.fetch = (async () => {
        return new Response("event: end\ndata: {}\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            Deprecation: "true",
            Warning: '299 - "events endpoint deprecated"',
            Sunset: "Wed, 01 Jan 2030 00:00:00 GMT",
          },
        });
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/jobs/job-1/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Warning")).toContain(
        "events endpoint deprecated",
      );
      expect(res.headers.get("Sunset")).toBe("Wed, 01 Jan 2030 00:00:00 GMT");
      expect(getRecordedDeprecation()?.message).toBe(
        "events endpoint deprecated",
      );
    });

    it("returns an empty list when no project state exists", async () => {
      // Branch coverage for the `if (!state) return c.json({ jobs: [] })`
      // early-return on /api/jobs.
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/jobs", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: unknown[] };
      expect(body.jobs).toEqual([]);
    });

    it("returns 400 on /api/jobs/:id/events when project state is missing", async () => {
      // Without `.arkor/state.json` written into trainCwd, the proxy has
      // no scope to forward.
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/jobs/j-xyz/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("No project state");
    });

    it("forwards Last-Event-ID through the SSE proxy", async () => {
      await writeCredentials(ANON_CREDS);
      // buildStudioApp passes `trainCwd` to readState(), so write the
      // state file there explicitly rather than mutating process cwd.
      await writeState(
        {
          orgSlug: "anon-org",
          projectSlug: "proj",
          projectId: "p1",
        },
        trainCwd,
      );
      let captured: { url: string; headers: Headers } | null = null;
      const enc = new TextEncoder();
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        captured = {
          url: String(input),
          headers: new Headers(init?.headers),
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode("event: ping\ndata: \n\n"));
              c.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/jobs/job-id-1/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "Last-Event-ID": "1700000000-evt-42",
        },
      });
      expect(res.status).toBe(200);
      const cap = captured as unknown as {
        url: string;
        headers: Headers;
      } | null;
      expect(cap).not.toBeNull();
      expect(cap!.headers.get("last-event-id")).toBe("1700000000-evt-42");
    });

    it("omits Last-Event-ID on /api/jobs/:id/events when the client did not supply one", async () => {
      // Branch coverage for the conditional Last-Event-ID forwarding.
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "anon-org",
          projectSlug: "proj",
          projectId: "p1",
        },
        trainCwd,
      );
      let captured: Headers | null = null;
      globalThis.fetch = (async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;

      const app = build();
      await app.request("/api/jobs/job-id-1/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      const cap = captured as unknown as Headers | null;
      expect(cap).not.toBeNull();
      expect(cap!.has("last-event-id")).toBe(false);
    });

    it("falls back to text/event-stream when the upstream omits a content-type", async () => {
      // Branch coverage for `upstream.headers.get("content-type") ?? "text/event-stream"`.
      // A Response with a string body auto-sets text/plain; using `null`
      // body avoids that default so the upstream genuinely lacks the
      // header.
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "anon-org",
          projectSlug: "proj",
          projectId: "p1",
        },
        trainCwd,
      );
      globalThis.fetch = (async () =>
        new Response(null, { status: 200 })) as typeof fetch;
      const app = build();
      const res = await app.request("/api/jobs/j1/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    });
  });

  describe("/api/manifest", () => {
    const FAKE_MANIFEST_SOURCE = `export const arkor = Object.freeze({
      _kind: "arkor",
      trainer: {
        name: "qa-bot",
        start: async () => ({ jobId: "j1" }),
        wait: async () => ({ job: {}, artifacts: [] }),
        cancel: async () => {},
      },
    });
    `;

    it("returns the trainer name when src/arkor/index.ts exports a manifest", async () => {
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, "src/arkor"), { recursive: true });
      writeFileSync(
        join(trainCwd, "src/arkor/index.ts"),
        FAKE_MANIFEST_SOURCE,
      );
      const app = build();
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        trainer: { name: string } | null;
      };
      expect(body.trainer).toEqual({ name: "qa-bot" });
    });

    it("returns 400 when src/arkor/index.ts is missing", async () => {
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/Build entry not found/);
    });

    it("falls back to mod.default when there's no `arkor` export", async () => {
      // Branch coverage for `mod.arkor ?? mod.default` in
      // studio/manifest.ts. Older sample code default-exports the
      // manifest object instead of named-exporting it; Studio must still
      // discover it.
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, "src/arkor"), { recursive: true });
      writeFileSync(
        join(trainCwd, "src/arkor/index.ts"),
        `export default Object.freeze({
          _kind: "arkor",
          trainer: {
            name: "default-trainer",
            start: async () => ({ jobId: "j1" }),
            wait: async () => ({ job: {}, artifacts: [] }),
            cancel: async () => {},
          },
        });\n`,
      );
      const app = build();
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        trainer: { name: string } | null;
      };
      expect(body.trainer).toEqual({ name: "default-trainer" });
    });

    it("returns the EMPTY manifest when neither `arkor` nor a valid default is exported", async () => {
      // Branch coverage for the `!isArkor(candidate)` early-return.
      // A user who exports a regular object that lacks `_kind: 'arkor'`
      // is treated as "no manifest yet" and the SPA can render the empty
      // state hint instead of crashing.
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, "src/arkor"), { recursive: true });
      writeFileSync(
        join(trainCwd, "src/arkor/index.ts"),
        `export default { somethingElse: true };\n`,
      );
      const app = build();
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { trainer: unknown };
      expect(body.trainer).toBeNull();
    });

    it("returns trainer:null when the manifest has no trainer slot", async () => {
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, "src/arkor"), { recursive: true });
      writeFileSync(
        join(trainCwd, "src/arkor/index.ts"),
        `export const arkor = Object.freeze({ _kind: "arkor" });\n`,
      );
      const app = build();
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { trainer: unknown };
      expect(body.trainer).toBeNull();
    });
  });

  describe("/api/inference/chat", () => {
    const ORIG_FETCH = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("auto-bootstraps project state and proxies base-model inference", async () => {
      await writeCredentials(ANON_CREDS);
      // No state.json — server should derive a slug from cwd, create the
      // project on cloud-api, persist state, and forward the inference call.

      const calls: Array<{
        url: string;
        method: string;
        body?: string;
        headers: Record<string, string>;
      }> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(
          (init?.headers ?? {}) as Record<string, string>,
        )) {
          headers[k.toLowerCase()] = v;
        }
        calls.push({ url, method, body, headers });
        if (url.includes("/v1/projects") && method === "POST") {
          return new Response(
            JSON.stringify({
              project: {
                id: "p-bootstrap",
                slug: "auto-slug",
                name: "auto",
                orgId: "anon-org-id",
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/inference/chat")) {
          return new Response("data: {\"content\":\"hi\"}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/inference/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseModel: "unsloth/gemma-4-e4b-it",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain('"content":"hi"');

      // State was persisted using the bootstrapped project's slug.
      const statePath = join(trainCwd, ".arkor", "state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        orgSlug: string;
        projectSlug: string;
        projectId: string;
      };
      expect(state).toEqual({
        orgSlug: "anon-org",
        projectSlug: "auto-slug",
        projectId: "p-bootstrap",
      });

      // Inference request carried the bootstrapped scope and the body verbatim.
      const chat = calls.find((c) => c.url.includes("/v1/inference/chat"));
      expect(chat).toBeDefined();
      expect(chat!.url).toContain("orgSlug=anon-org");
      expect(chat!.url).toContain("projectSlug=auto-slug");
      expect(chat!.body).toContain("unsloth/gemma-4-e4b-it");
      // X-Arkor-Client must be present, otherwise cloud-api's SDK version
      // gate rejects the proxied request with 426 (reason: "missing").
      expect(chat!.headers["x-arkor-client"]).toMatch(/^arkor\/\S+$/);
    });

    it("proxies inference using existing state without re-creating a project", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        { orgSlug: "anon-org", projectSlug: "existing", projectId: "p-existing" },
        trainCwd,
      );

      const calls: Array<{ url: string; method: string }> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/v1/inference/chat")) {
          return new Response("data: {\"content\":\"ok\"}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/inference/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseModel: "unsloth/gemma-4-e4b-it",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);

      // Only the inference call should have hit the network — no project
      // create/list when state is already present.
      expect(calls.filter((c) => c.url.includes("/v1/projects"))).toHaveLength(0);
      const chat = calls.find((c) => c.url.includes("/v1/inference/chat"));
      expect(chat!.url).toContain("projectSlug=existing");
    });

    it("propagates the cloud-api status when project bootstrap fails", async () => {
      await writeCredentials(ANON_CREDS);
      // No state.json — bootstrap will hit cloud-api, which returns 503.
      // We expect that 503 to be passed through, not collapsed to 400.

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/v1/projects") && method === "POST") {
          return new Response(JSON.stringify({ error: "upstream is down" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }) as typeof fetch;

      const app = build();
      const res = await app.request("/api/inference/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseModel: "unsloth/gemma-4-e4b-it",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/upstream is down/);
    });

    it("returns 500 with a controlled body when getCredentials throws", async () => {
      // autoAnonymous: false + no credentials → getCredentials() throws inside
      // the handler. Previously this surfaced as an unhandled 500 from Hono's
      // default error path; now it's caught and returned as a structured
      // response so clients can render the error.
      const app = build(); // build() uses autoAnonymous: false
      const res = await app.request("/api/inference/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseModel: "unsloth/gemma-4-e4b-it",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/credentials|login/i);
    });
  });

  // -------------------------------------------------------------------------
  // Deployments (`/api/deployments/*`) — minimal coverage of the router
  // boundary. Cloud-side semantics already have heavy test coverage in
  // `core/client.deployments.test.ts`; here we verify only that the Studio
  // server forwards correctly, returns the empty wrapper when no project
  // state exists, and surfaces upstream errors verbatim.
  // -------------------------------------------------------------------------
  describe("/api/deployments", () => {
    const ORIG_FETCH = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("returns an empty deployments list when no project state is on disk", async () => {
      // Mirrors the `/api/jobs` empty path. No upstream fetch should happen.
      await writeCredentials(ANON_CREDS);
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("should not call upstream when no scope");
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deployments: [] });
      expect(calls).toBe(0);
    });

    it("forwards GET /api/deployments to /v1/endpoints with project scope", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "anon-org",
          projectSlug: "p",
          projectId: "p-id",
        },
        trainCwd,
      );
      let upstreamUrl: string | null = null;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return new Response(
          JSON.stringify({
            deployments: [
              {
                id: "d1",
                slug: "x",
                orgId: "o",
                projectId: "p",
                target: { kind: "base_model", baseModel: "m" },
                authMode: "none",
                urlFormat: "openai_compat",
                enabled: true,
                customDomain: null,
                createdAt: "2026-05-05T00:00:00Z",
                updatedAt: "2026-05-05T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deployments: { slug: string }[] };
      expect(body.deployments[0]?.slug).toBe("x");
      expect(upstreamUrl).toContain("/v1/endpoints");
      expect(upstreamUrl).toContain("orgSlug=anon-org");
      expect(upstreamUrl).toContain("projectSlug=p");
    });

    it("propagates upstream 409 with the upstream error message", async () => {
      await writeCredentials(ANON_CREDS);
      await writeState(
        { orgSlug: "anon-org", projectSlug: "p", projectId: "p-id" },
        trainCwd,
      );
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ error: "Deployment slug is already taken" }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          slug: "taken",
          target: { kind: "base_model", baseModel: "m" },
          authMode: "none",
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/already taken/);
    });

    it("rejects mutating /api/deployments without a studio token", async () => {
      const app = build();
      const res = await app.request("/api/deployments", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it("bootstraps `.arkor/state.json` on first anonymous POST and forwards the create", async () => {
      // Coverage for the write-path branch in `withDeploymentClient` that
      // calls `ensureProjectState()` for anonymous workspaces with no
      // state file. The first POST should create the project (PROJECT
      // upsert), persist `.arkor/state.json`, and then forward the
      // deployment create with the resolved scope. Without this branch
      // working, the very first "Create endpoint" click on a fresh
      // anonymous workspace would hard-fail.
      await writeCredentials(ANON_CREDS);
      const upstreamCalls: { url: string; method?: string }[] = [];
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const url = String(input);
        upstreamCalls.push({ url, method: init?.method });
        if (url.includes("/v1/projects") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              project: {
                id: "p-id",
                slug: "anon-cwd",
                name: "anon-cwd",
                orgId: "o-id",
                createdAt: "2026-05-04T00:00:00Z",
                updatedAt: "2026-05-04T00:00:00Z",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/endpoints") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ deployment: deploymentResponse("first") }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected upstream call: ${init?.method} ${url}`);
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments", {
        method: "POST",
        headers: studioHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          slug: "first",
          target: { kind: "base_model", baseModel: "m" },
          authMode: "none",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deployment: { slug: string } };
      expect(body.deployment.slug).toBe("first");
      // The bootstrap must precede the endpoint create, otherwise the
      // endpoint POST would have nothing to scope itself to.
      const projectIdx = upstreamCalls.findIndex((c) =>
        c.url.includes("/v1/projects"),
      );
      const endpointIdx = upstreamCalls.findIndex((c) =>
        c.url.includes("/v1/endpoints"),
      );
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      expect(endpointIdx).toBeGreaterThan(projectIdx);
    });

    it("rejects POST /api/deployments with a manual-state hint when Auth0 creds have no state file", async () => {
      // Coverage for the Auth0 branch in `withDeploymentClient`: we
      // intentionally do NOT bootstrap because we don't know which org
      // the logged-in user wants the deployment in. The error must
      // point at the only working remediation today (write `.arkor/
      // state.json` by hand), since `arkor login` and `arkor init`
      // both leave that file untouched.
      await writeCredentials({
        mode: "auth0",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 0,
        auth0Domain: "d",
        audience: "a",
        clientId: "c",
      });
      let upstreamCalls = 0;
      globalThis.fetch = (async () => {
        upstreamCalls++;
        throw new Error("upstream must not be called");
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments", {
        method: "POST",
        headers: studioHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          slug: "x",
          target: { kind: "base_model", baseModel: "m" },
          authMode: "none",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/\.arkor\/state\.json/);
      expect(body.error).toMatch(/by hand/);
      expect(upstreamCalls).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Per-id and key-sub-route coverage. The previous block covered list +
    // create + 409. Each handler below is an independent forward path with
    // its own param parsing + body parsing + error normalization, so a
    // boundary test per route catches regressions in any of those.
    // -----------------------------------------------------------------------
    function deploymentResponse(slug = "x") {
      return {
        id: "00000000-0000-4000-8000-000000000010",
        slug,
        orgId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        target: { kind: "base_model", baseModel: "m" },
        authMode: "none",
        urlFormat: "openai_compat",
        enabled: true,
        customDomain: null,
        createdAt: "2026-05-04T00:00:00Z",
        updatedAt: "2026-05-04T00:00:00Z",
      };
    }

    async function arrangeProjectState() {
      await writeCredentials(ANON_CREDS);
      await writeState(
        { orgSlug: "anon-org", projectSlug: "p", projectId: "p-id" },
        trainCwd,
      );
    }

    function studioHeaders(extra: Record<string, string> = {}) {
      return {
        host: "127.0.0.1:4000",
        "x-arkor-studio-token": STUDIO_TOKEN,
        ...extra,
      };
    }

    it("GET /api/deployments/:id forwards to /v1/endpoints/:id", async () => {
      await arrangeProjectState();
      let upstreamUrl: string | null = null;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return new Response(
          JSON.stringify({ deployment: deploymentResponse("alpha") }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(200);
      expect(upstreamUrl).toContain("/v1/endpoints/dep-1");
      expect(upstreamUrl).toContain("orgSlug=anon-org");
    });

    it("PATCH /api/deployments/:id sends the body verbatim to upstream", async () => {
      await arrangeProjectState();
      let upstreamMethod: string | undefined;
      let upstreamBody: string | undefined;
      globalThis.fetch = (async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        upstreamMethod = init?.method;
        upstreamBody = init?.body as string | undefined;
        return new Response(
          JSON.stringify({
            deployment: { ...deploymentResponse(), enabled: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1", {
        method: "PATCH",
        headers: studioHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(upstreamMethod).toBe("PATCH");
      expect(JSON.parse(upstreamBody as string)).toEqual({ enabled: false });
    });

    it("PATCH /api/deployments/:id rejects malformed JSON with 400 (no upstream call)", async () => {
      await arrangeProjectState();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("upstream should not be called");
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1", {
        method: "PATCH",
        headers: studioHeaders({ "content-type": "application/json" }),
        body: "not-json",
      });
      expect(res.status).toBe(400);
      expect(calls).toBe(0);
    });

    it("DELETE /api/deployments/:id normalizes upstream 204 to a 200 `{}` envelope", async () => {
      // The cloud API answers 204; the SDK promise resolves to void; the
      // Studio router serializes that as JSON 200 `{}` so the SPA's JSON
      // parsing path is uniform across every route.
      await arrangeProjectState();
      let upstreamMethod: string | undefined;
      globalThis.fetch = (async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        upstreamMethod = init?.method;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1", {
        method: "DELETE",
        headers: studioHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(upstreamMethod).toBe("DELETE");
    });

    it("GET /api/deployments/:id/keys forwards to the keys sub-route", async () => {
      await arrangeProjectState();
      let upstreamUrl: string | null = null;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return new Response(
          JSON.stringify({
            keys: [
              {
                id: "k1",
                label: "production",
                prefix: "ark_live_",
                enabled: true,
                createdAt: "2026-05-04T00:00:00Z",
                lastUsedAt: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1/keys", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(200);
      expect(upstreamUrl).toContain("/v1/endpoints/dep-1/keys");
    });

    it("POST /api/deployments/:id/keys preserves the plaintext envelope", async () => {
      await arrangeProjectState();
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            key: {
              id: "k1",
              label: "production",
              plaintext: "ark_live_TESTSECRET",
              prefix: "ark_live_T",
              createdAt: "2026-05-04T00:00:00Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1/keys", {
        method: "POST",
        headers: studioHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ label: "production" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        key: { plaintext: string };
      };
      expect(body.key.plaintext).toBe("ark_live_TESTSECRET");
    });

    it("DELETE /api/deployments/:id/keys/:keyId hits the right upstream path", async () => {
      await arrangeProjectState();
      let upstreamUrl: string | null = null;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1/keys/k1", {
        method: "DELETE",
        headers: studioHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(upstreamUrl).toContain("/v1/endpoints/dep-1/keys/k1");
    });

    it("listing without project state returns an empty wrapper without calling getCredentials", async () => {
      // Regression for the P2 review: previously this path failed when
      // the credentials file was missing AND autoAnonymous was false,
      // because withDeploymentClient's `getCredentials()` ran *before*
      // the no-scope short-circuit and threw. The list view should be
      // a local no-op on a fresh workspace.
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("should not call upstream when no scope");
      }) as typeof fetch;
      const app = build(); // build() pins autoAnonymous: false
      const res = await app.request("/api/deployments", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deployments: [] });
      expect(calls).toBe(0);
    });

    it("GET /api/deployments/:id on a fresh workspace returns 404 without calling getCredentials", async () => {
      // Regression: the read-path short-circuit must run *before*
      // `getCredentials()`. Otherwise on a fresh workspace where
      // `~/.arkor/credentials.json` is absent and `autoAnonymous=false`,
      // a bookmarked detail-page hit would surface a 500 ("Studio backend
      // unavailable") instead of the documented "no deployments yet" 404.
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("should not call upstream when no scope");
      }) as typeof fetch;
      const app = build(); // build() pins autoAnonymous: false
      const res = await app.request("/api/deployments/dep-1", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain(".arkor/state.json");
      expect(calls).toBe(0);
    });

    it("GET /api/deployments/:id/keys on a fresh workspace returns 404 without calling getCredentials", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("should not call upstream when no scope");
      }) as typeof fetch;
      const app = build();
      const res = await app.request("/api/deployments/dep-1/keys", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(404);
      expect(calls).toBe(0);
    });

    it("returns 401 with a log-in hint when the credentials file is missing", async () => {
      // autoAnonymous: false + no credentials + project state present →
      // getCredentials() throws "No credentials on file. Run `arkor
      // login` first." This is a recoverable setup problem, not a
      // backend outage, so the SPA gets the actionable message
      // verbatim with a 401 instead of an opaque 500.
      await writeState(
        { orgSlug: "anon-org", projectSlug: "p", projectId: "p-id" },
        trainCwd,
      );
      const app = build();
      const res = await app.request("/api/deployments/dep-1", {
        headers: studioHeaders(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/no credentials on file/i);
      expect(body.error).toMatch(/arkor login/);
    });
  });
});
