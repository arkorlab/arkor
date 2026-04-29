import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-studio-test-"));
  process.env.HOME = fakeHome;
  assetsDir = mkdtempSync(join(tmpdir(), "arkor-studio-assets-"));
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    "<!doctype html><html><head><title>Studio</title></head><body></body></html>",
  );
  trainCwd = mkdtempSync(join(tmpdir(), "arkor-studio-cwd-"));
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
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

  describe("/api/credentials telemetry block", () => {
    const ORIG_DO_NOT_TRACK = process.env.DO_NOT_TRACK;
    const ORIG_DEBUG = process.env.ARKOR_TELEMETRY_DEBUG;

    afterEach(() => {
      if (ORIG_DO_NOT_TRACK !== undefined)
        process.env.DO_NOT_TRACK = ORIG_DO_NOT_TRACK;
      else delete process.env.DO_NOT_TRACK;
      if (ORIG_DEBUG !== undefined)
        process.env.ARKOR_TELEMETRY_DEBUG = ORIG_DEBUG;
      else delete process.env.ARKOR_TELEMETRY_DEBUG;
    });

    it("includes a telemetry block with anon distinctId and disabled flag in tests", async () => {
      // No __ARKOR_POSTHOG_KEY__ is injected in this test environment, so
      // enabled must be false and posthogKey must be empty.
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        telemetry?: {
          enabled: boolean;
          distinctId: string;
          authMode: string;
          posthogKey: string;
          posthogHost: string;
          sdkVersion: string;
          debug: boolean;
        };
      };
      expect(body.telemetry).toBeDefined();
      expect(body.telemetry!.enabled).toBe(false);
      expect(body.telemetry!.posthogKey).toBe("");
      expect(body.telemetry!.distinctId).toBe("anon-id");
      expect(body.telemetry!.authMode).toBe("anon");
      expect(body.telemetry!.posthogHost).toMatch(/posthog\.com$/);
      expect(typeof body.telemetry!.sdkVersion).toBe("string");
      expect(body.telemetry!.debug).toBe(false);
    });

    it("forces enabled=false when DO_NOT_TRACK is set", async () => {
      process.env.DO_NOT_TRACK = "1";
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      const body = (await res.json()) as {
        telemetry?: { enabled: boolean; posthogKey: string };
      };
      expect(body.telemetry!.enabled).toBe(false);
      expect(body.telemetry!.posthogKey).toBe("");
    });

    it("reflects ARKOR_TELEMETRY_DEBUG in the debug field", async () => {
      process.env.ARKOR_TELEMETRY_DEBUG = "1";
      await writeCredentials(ANON_CREDS);
      const app = build();
      const res = await app.request("/api/credentials", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      const body = (await res.json()) as { telemetry?: { debug: boolean } };
      expect(body.telemetry!.debug).toBe(true);
    });
  });

  it("accepts the studio token via ?studioToken= for SSE-style requests", async () => {
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-id",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-org",
    });
    const app = build();
    const res = await app.request(
      `/api/credentials?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
      { headers: { host: "127.0.0.1:4000" } },
    );
    expect(res.status).toBe(200);
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

  // Regression for ENG-404 — `path.resolve` doesn't follow symlinks, so a
  // link inside the project directory pointing outside it would previously
  // pass the containment check and be handed to `arkor start` (which would
  // then dlopen the link's target).
  it("rejects /api/train when body.file is a symlink to a path outside cwd", async () => {
    await writeCredentials(ANON_CREDS);
    symlinkSync("/etc/passwd", join(trainCwd, "evil.ts"));
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
});
