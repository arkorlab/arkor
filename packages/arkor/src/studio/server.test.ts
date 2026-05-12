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
import type { HmrCoordinator, HmrEvent } from "./hmr";
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
    // HMR meta tag must NOT appear when no coordinator was supplied.
    // The SPA reads this flag to decide whether to open
    // `/api/dev/events`; a stray "true" here would make every prod
    // session retry against the 404 indefinitely.
    expect(html).not.toContain("arkor-hmr-enabled");
  });

  it("injects <meta name=\"arkor-hmr-enabled\"> when an HMR coordinator is supplied", async () => {
    // Regression: the SPA can't tell dev-mode usage from prod-mode
    // usage at runtime — `vite build` ships with
    // `import.meta.env.DEV === false`, so a build-time DEV gate inside
    // the SPA bundle would (wrongly) suppress HMR even in real
    // `arkor dev` sessions. The server-side flag is `true` exactly
    // when `arkor dev` wired in an HMR coordinator. Verify it lands
    // in `<head>` next to the studio-token tag.
    const fakeHmr = {
      subscribe: () => () => undefined,
      getCurrentConfigHash: () => null,
      getCurrentArtifactHash: () => null,
      getCurrentArtifactContentHash: () => null,
      getLastEventType: () => null,
      async dispose() {},
    };
    const app = buildStudioApp({
      baseUrl: "http://mock",
      assetsDir,
      autoAnonymous: false,
      studioToken: STUDIO_TOKEN,
      cwd: trainCwd,
      hmr: fakeHmr,
    });
    const res = await app.request("/", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<meta name="arkor-hmr-enabled" content="true">`,
    );
    expect(html.indexOf("arkor-hmr-enabled")).toBeLessThan(
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
      // Regression: the spawned subprocess's pid is exposed via the
      // `X-Arkor-Train-Pid` response header so the SPA can scope HMR
      // restart events to its own child (a multi-tab broadcast can
      // contain mixed restart/hot-swap targets across siblings).
      const pidHeader = res.headers.get("x-arkor-train-pid");
      expect(pidHeader).toMatch(/^\d+$/);
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

    it("captures the spawn-time configHash from the HMR coordinator (no extra rebuild)", async () => {
      // Regression: `/api/train` previously called `readManifestSummary`
      // which ran a full `runBuild()` per spawn — wasteful and racy
      // against the HMR watcher writing the same `.arkor/build/index.mjs`.
      // The new server reads the cached hash from
      // `coordinator.getCurrentConfigHash()` instead. We assert the
      // call happens (so a rebuild is *not* required) by exposing the
      // spy count on the fake coordinator.
      await writeCredentials(ANON_CREDS);
      let getCurrentCalls = 0;
      const fakeHmr = {
        subscribe: () => () => undefined,
        getCurrentConfigHash: () => {
          getCurrentCalls += 1;
          return "spawn-time-hash";
        },
        getCurrentArtifactHash: () => "spawn-artefact-hash",
        getCurrentArtifactContentHash: () => "spawn-artefact-content-hash",
        getLastEventType: () => null,
        async dispose() {},
      };
      const fakeBin = join(trainCwd, "fake-bin.mjs");
      writeFileSync(fakeBin, `process.exit(0);\n`);
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: fakeBin,
        hmr: fakeHmr,
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
      // Drain the body so the close handler runs and the test
      // doesn't leak the subprocess.
      await res.text();
      expect(getCurrentCalls).toBe(1);
    });

    it("/api/train job-id parser ignores stderr so a `Started job <token>` line on stderr can't hijack the cancel POST", async () => {
      // Regression: the job-id detector used to consume both
      // stdout AND stderr through a shared `onChunk` + shared
      // line buffer. A user `console.error("Started job <token>")`
      // on stderr would then poison the buffer first; the real
      // stdout marker arrives later but our `getJobId(...) === null`
      // gate has already short-circuited subsequent scans, so
      // Stop-training POSTs cancel for the wrong (decoy) job and
      // the real one keeps running — silent cloud orphan.
      // Splitting into a stdout-only `onStdoutChunk` parser and a
      // forward-only `onStderrChunk` makes stderr unable to
      // populate `jobId` regardless of what the user logs there.
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "stderr-test-org",
          projectSlug: "stderr-test-project",
          projectId: "p-stderr",
        },
        trainCwd,
      );
      // Bin emits a decoy `Started job <token>` to STDERR first
      // (would poison the shared buffer), then the canonical real
      // line to STDOUT, then hangs. With the split we expect the
      // real id to win; with the bug the decoy would win.
      const REAL_JOB_ID = "real-job-id";
      const DECOY_JOB_ID = "decoy-from-stderr";
      const fakeBin = join(trainCwd, "stderr-decoy-bin.mjs");
      writeFileSync(
        fakeBin,
        `process.stderr.write("Started job ${DECOY_JOB_ID}\\n");
        // Slight delay so stderr lands first.
        setTimeout(() => {
          process.stdout.write("Started job ${REAL_JOB_ID}\\n");
        }, 30);
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 60_000);
        `,
      );
      let cancelHits: Array<{ url: string }> = [];
      const ORIG_FETCH = globalThis.fetch;
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "POST" && /\/v1\/jobs\/[^/]+\/cancel/.test(url)) {
          cancelHits.push({ url });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      try {
        const app = buildStudioApp({
          baseUrl: "http://mock-cloud-api",
          assetsDir,
          autoAnonymous: false,
          studioToken: STUDIO_TOKEN,
          cwd: trainCwd,
          binPath: fakeBin,
        });
        const trainRes = await app.request("/api/train", {
          method: "POST",
          headers: {
            host: "127.0.0.1:4000",
            "x-arkor-studio-token": STUDIO_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        expect(trainRes.status).toBe(200);
        // Drain until the REAL line is in the body. Both the
        // decoy and the real line forward through to the SPA log
        // stream, so both bytes show up here regardless of which
        // (if any) the parser captures.
        const reader = trainRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!buf.includes(`Started job ${REAL_JOB_ID}`)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        await reader.cancel();
        await new Promise((r) => setTimeout(r, 200));

        // The cancel POST must target the REAL id. With the bug
        // the decoy would have been recorded first → cancelHits[0]
        // would contain `decoy-from-stderr` instead.
        expect(cancelHits).toHaveLength(1);
        expect(cancelHits[0]?.url).toContain(`/v1/jobs/${REAL_JOB_ID}/cancel`);
        expect(cancelHits[0]?.url).not.toContain(DECOY_JOB_ID);
      } finally {
        globalThis.fetch = ORIG_FETCH;
      }
    });

    it("/api/train cancel POSTs cloud /v1/jobs/:id/cancel so the cloud job is released even though SIGKILL bypasses the runner's shutdown handlers", async () => {
      // Regression: SIGKILL kills the runner without giving its
      // `installShutdownHandlers` a chance to issue the cloud
      // `cancel()` POST itself. Without a server-side equivalent
      // the cloud job sits in "running" until TTL/reaper, so a
      // user clicking "Stop training" silently keeps consuming
      // GPU spend. The fix parses the runner's `Started job <id>`
      // stdout line, records the id on the registry entry, and
      // fires a fire-and-forget POST to cloud-api on cancel
      // *before* SIGKILLing.
      await writeCredentials(ANON_CREDS);
      // The cancel POST reads scope from `.arkor/state.json` (not
      // from the anon creds' orgSlug — that's a different code
      // path). Pre-seed so the POST can address the cloud job.
      await writeState(
        {
          orgSlug: "cancel-test-org",
          projectSlug: "cancel-test-project",
          projectId: "p-cancel",
        },
        trainCwd,
      );
      // Bin prints the canonical "Started job <id>" line then
      // hangs (just like the real runner after `start()` resolves).
      // The id is the same kind of identifier cloud-api would
      // mint — opaque string we'll verify shows up in the cancel
      // POST URL below.
      const FAKE_JOB_ID = "j-cancel-test";
      const fakeBin = join(trainCwd, "started-job-bin.mjs");
      writeFileSync(
        fakeBin,
        `process.stdout.write("Started job ${FAKE_JOB_ID}\\n");
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 60_000);
        `,
      );
      // Capture the cloud-api requests so we can verify the
      // server's cancel POST landed with the right job id +
      // scope. The default fetch in this suite would 404 our POST
      // and leave it as `cancelCalls === 0`.
      let cancelHits: Array<{ url: string; method: string }> = [];
      const ORIG_FETCH = globalThis.fetch;
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (
          method === "POST" &&
          url.includes(`/v1/jobs/${FAKE_JOB_ID}/cancel`)
        ) {
          cancelHits.push({ url, method });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Pass-through default: anything else 404s — which would
        // surface as a test-side failure if our cancel POST
        // doesn't match the expected URL shape.
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      try {
        const app = buildStudioApp({
          baseUrl: "http://mock-cloud-api",
          assetsDir,
          autoAnonymous: false,
          studioToken: STUDIO_TOKEN,
          cwd: trainCwd,
          binPath: fakeBin,
        });
        const trainRes = await app.request("/api/train", {
          method: "POST",
          headers: {
            host: "127.0.0.1:4000",
            "x-arkor-studio-token": STUDIO_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        expect(trainRes.status).toBe(200);
        // Read enough of the body to ensure the runner's
        // `Started job <id>` chunk has been processed by the
        // server's stdout parser (without this, cancel could
        // race ahead of the parser and find no jobId on the
        // registry → no cancel POST → false test failure).
        const reader = trainRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!buf.includes(`Started job ${FAKE_JOB_ID}`)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        // Trigger cancel — should fire the cloud POST + SIGKILL.
        await reader.cancel();
        // Fire-and-forget: give the void IIFE a tick to actually
        // dispatch the fetch + receive the 200 response.
        await new Promise((r) => setTimeout(r, 200));

        expect(cancelHits).toHaveLength(1);
        expect(cancelHits[0]?.url).toContain(`/v1/jobs/${FAKE_JOB_ID}/cancel`);
        // Scope is required by the cloud-api contract — comes from
        // `.arkor/state.json` (seeded above), not the anon creds.
        expect(cancelHits[0]?.url).toContain("orgSlug=cancel-test-org");
        expect(cancelHits[0]?.url).toContain("projectSlug=cancel-test-project");
      } finally {
        globalThis.fetch = ORIG_FETCH;
      }
    });

    it("/api/train cancel sends SIGKILL so user-initiated stop bypasses the runner's graceful early-stop", async () => {
      // Regression: a default `child.kill()` sends SIGTERM, which
      // the runner's `installShutdownHandlers` now interprets as a
      // graceful early-stop request (wait for the next checkpoint,
      // up to ~5 min). For HMR-driven cancels that's correct, but
      // for a Stop-training click the user wants the run STOPPED
      // immediately — leaving it running in the background for
      // minutes consuming GPU spend silently is a regression
      // introduced by this PR's graceful-shutdown work. We assert
      // SIGKILL by giving the bin a SIGTERM no-op handler: SIGTERM
      // would be swallowed and the bin would stay alive; SIGKILL
      // is uncatchable and reaps the process unconditionally.
      // Probe liveness with `process.kill(pid, 0)` (ESRCH ⇒ gone).
      await writeCredentials(ANON_CREDS);
      const hangingBin = join(trainCwd, "hanging-bin.mjs");
      writeFileSync(
        hangingBin,
        // SIGTERM swallowed; setInterval keeps the event loop
        // alive forever absent SIGKILL.
        `process.on("SIGTERM", () => {});
        setInterval(() => {}, 60_000);
        `,
      );
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: hangingBin,
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
      const pid = Number(res.headers.get("x-arkor-train-pid"));
      expect(Number.isFinite(pid)).toBe(true);

      // Trigger the cancel() handler.
      await res.body!.cancel();

      // Give the OS a moment to deliver SIGKILL and reap.
      await new Promise((r) => setTimeout(r, 300));

      // `process.kill(pid, 0)` is the standard "is this pid alive?"
      // probe — sends signal 0 (no-op) but the syscall still
      // surfaces ESRCH for non-existent pids. SIGKILL → reaped →
      // ESRCH. SIGTERM (with the bin's no-op handler) → still
      // alive → no throw → test fails.
      let probeError: NodeJS.ErrnoException | null = null;
      try {
        process.kill(pid, 0);
      } catch (e) {
        probeError = e as NodeJS.ErrnoException;
      }
      expect(probeError).not.toBeNull();
      expect(probeError?.code).toBe("ESRCH");
    });

    it("/api/train cancel handler doesn't crash when child.kill() throws", async () => {
      // Regression: `ReadableStream.cancel()` called `child.kill()`
      // without a try/catch. If the child had already exited (ESRCH
      // race against the cancel), the throw bubbled up as an
      // unhandled exception and crashed the request handler.
      await writeCredentials(ANON_CREDS);
      const fakeBin = join(trainCwd, "fake-bin.mjs");
      // Bin exits immediately so the child is already dead by the
      // time our cancel handler tries to signal it.
      writeFileSync(fakeBin, `process.exit(0);\n`);
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
      // Race: read enough of the body to see the close, then cancel.
      // The cancel hook must not throw even when the underlying
      // child is already gone.
      const reader = res.body!.getReader();
      // Wait for `exit=` so we know the child died first.
      let buf = "";
      const decoder = new TextDecoder();
      while (!buf.includes("exit=")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      await expect(reader.cancel()).resolves.toBeUndefined();
    });

    it("/api/train survives cancellation while the child is still streaming output", async () => {
      // Regression: the previous implementation registered raw
      // `controller.enqueue(...)` listeners on `child.stdout` /
      // `child.stderr` and an unguarded `controller.close()` in
      // `child.on("close")`. After the client cancelled the
      // ReadableStream, those handlers kept firing — and calling
      // `enqueue` / `close` on a closed controller throws "Invalid
      // state". The throw escaped the request pipeline as an
      // unhandled exception. The fix flips a `closed` flag in
      // `cancelTeardown` and try/catches the post-cancel enqueue
      // paths defensively. NOTE: cancel intentionally does NOT
      // detach the `data` listeners — leaving them attached keeps
      // the OS pipe draining while the child checkpoints / exits
      // gracefully (otherwise a full pipe back-pressures and
      // deadlocks the very graceful exit we're preserving).
      // `onClose` / `onError` detach all listeners when the child
      // finally exits. See `cancelTeardown` in `studio/server.ts`
      // for the full backpressure rationale.
      await writeCredentials(ANON_CREDS);
      const fakeBin = join(trainCwd, "fake-bin.mjs");
      // Bin spits a chunk every ~5 ms forever. We cancel while it's
      // mid-stream so the child is *still alive* when listeners are
      // removed — the previous bug only surfaced in this window.
      writeFileSync(
        fakeBin,
        `setInterval(() => process.stdout.write("tick\\n"), 5);\nsetInterval(() => {}, 60_000);\n`,
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
      const reader = res.body!.getReader();
      // Read at least one chunk so the child is definitely streaming
      // before we cancel — that's the race window the previous code
      // crashed in.
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("tick")) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      // Listen for unhandled rejections / uncaught exceptions during
      // and shortly after the cancel — before the fix, the child's
      // next `data` chunk would synchronously throw inside the
      // enqueue callback.
      const errors: unknown[] = [];
      const onUnhandled = (err: unknown) => errors.push(err);
      process.on("uncaughtException", onUnhandled);
      process.on("unhandledRejection", onUnhandled);
      try {
        await reader.cancel();
        // Give the child's interval a few iterations to attempt
        // post-cancel writes. The handler must short-circuit on the
        // `closed` flag and not crash the worker.
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        process.off("uncaughtException", onUnhandled);
        process.off("unhandledRejection", onUnhandled);
      }
      expect(errors).toEqual([]);
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

    it("skips runBuild() when HMR is enabled and the watcher's artefact already exists", async () => {
      // Regression: previously every `/api/manifest` poll triggered a
      // fresh `runBuild()` even with HMR active, so the SPA's
      // ~5 s polling + per-rebuild SSE refetch would re-bundle on
      // every poll AND race the watcher writing to the same
      // `.arkor/build/index.mjs`. The fast path inspects the
      // pre-existing artefact directly when HMR's coordinator is
      // wired in. We assert by pre-writing a hand-rolled artefact
      // bundle and verifying `/api/manifest` returns its trainer
      // *without* the source file existing — `runBuild()` would
      // throw on the missing entry, so a 200 here proves we never
      // called it.
      await writeCredentials(ANON_CREDS);
      // Write the artefact that the HMR watcher would have produced.
      // Mirrors the seed fixture's shape: `_kind: "arkor"` + trainer
      // with the four required methods.
      mkdirSync(join(trainCwd, ".arkor/build"), { recursive: true });
      writeFileSync(
        join(trainCwd, ".arkor/build/index.mjs"),
        `const trainer = {
          name: "hmr-fast-path",
          start: async () => ({ jobId: "j" }),
          wait: async () => ({ job: {}, artifacts: [] }),
          cancel: async () => {},
        };
        export const arkor = { _kind: "arkor", trainer };
        export default arkor;
        `,
      );
      // Notice: NO `src/arkor/index.ts`. `runBuild()` would fail with
      // "Build entry not found" — the test fails if the fast path
      // regresses and falls through to it.
      const fakeHmr = {
        subscribe: () => () => undefined,
        getCurrentConfigHash: () => null,
        getCurrentArtifactHash: () => null,
        getCurrentArtifactContentHash: () => null,
        getLastEventType: () => null,
        async dispose() {},
      };
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fakeHmr,
      });
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
      expect(body.trainer).toEqual({ name: "hmr-fast-path" });
    });

    it("falls back to runBuild() when HMR is enabled but the watcher hasn't produced an artefact yet", async () => {
      // Companion to the fast-path test: on a fresh scaffold the
      // watcher's first BUNDLE_END may not have completed by the
      // time the SPA's first /api/manifest poll lands. Without the
      // existsSync gate we'd `await import(missing)` and 400
      // forever (the watcher's later writes don't retroactively
      // make this poll succeed); with the gate we bootstrap via
      // `runBuild()` for that single call.
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, "src/arkor"), { recursive: true });
      writeFileSync(
        join(trainCwd, "src/arkor/index.ts"),
        `export const arkor = Object.freeze({
          _kind: "arkor",
          trainer: {
            name: "fallback-build",
            start: async () => ({ jobId: "j" }),
            wait: async () => ({ job: {}, artifacts: [] }),
            cancel: async () => {},
          },
        });`,
      );
      // No pre-existing `.arkor/build/index.mjs` — the artefact
      // doesn't exist. `existsSync` is false → `runBuild()` runs.
      const fakeHmr = {
        subscribe: () => () => undefined,
        getCurrentConfigHash: () => null,
        getCurrentArtifactHash: () => null,
        getCurrentArtifactContentHash: () => null,
        getLastEventType: () => null,
        async dispose() {},
      };
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fakeHmr,
      });
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
      expect(body.trainer).toEqual({ name: "fallback-build" });
    });

    it("returns 400 (not stale 200) while the HMR watcher is in error state", async () => {
      // Regression: the HMR fast path served the last-built artefact
      // even when the watcher's most recent event was `error`. The
      // SPA's `/api/manifest` poll runs every ~5s, so a successful
      // 200 with stale data would silently overwrite the SSE-driven
      // build-error UI within 5s of the user breaking their source —
      // they'd then unknowingly run stale code/config while the
      // latest edit is still failing to compile. Gating the fast
      // path on `getLastEventType() === "error"` keeps both
      // channels (poll + SSE) consistent.
      await writeCredentials(ANON_CREDS);
      mkdirSync(join(trainCwd, ".arkor/build"), { recursive: true });
      // Pre-write a previously-good artefact so the fast path
      // *would* otherwise return 200 with it.
      writeFileSync(
        join(trainCwd, ".arkor/build/index.mjs"),
        `const trainer = {
          name: "stale-good-build",
          start: async () => ({ jobId: "j" }),
          wait: async () => ({ job: {}, artifacts: [] }),
          cancel: async () => {},
        };
        export const arkor = { _kind: "arkor", trainer };
        export default arkor;
        `,
      );
      // Coordinator is currently in error state — the latest
      // broadcast was a compile failure.
      const fakeHmr = {
        subscribe: () => () => undefined,
        getCurrentConfigHash: () => null,
        getCurrentArtifactHash: () => null,
        getCurrentArtifactContentHash: () => null,
        getLastEventType: () => "error" as const,
        async dispose() {},
      };
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fakeHmr,
      });
      const res = await app.request("/api/manifest", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      // 400 — the SPA's existing 4xx-handling path renders the
      // build-error hint instead of a fake-healthy manifest.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/Build failed/);
      // Sanity: the stale artefact name is NOT leaked through.
      expect(JSON.stringify(body)).not.toContain("stale-good-build");
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
          baseModel: "unsloth/gemma-4-E4B-it",
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
      expect(chat!.body).toContain("unsloth/gemma-4-E4B-it");
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
          baseModel: "unsloth/gemma-4-E4B-it",
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
          baseModel: "unsloth/gemma-4-E4B-it",
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
          baseModel: "unsloth/gemma-4-E4B-it",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/credentials|login/i);
    });
  });

  describe("/api/dev/events (HMR)", () => {
    function fakeHmr(initialConfigHash: string | null = null) {
      // Mirror the real HmrCoordinator surface but stay synchronous so
      // the test doesn't depend on rolldown.watch starting up. `emit`
      // is a test hook for pushing events into the SSE stream from the
      // test body; `currentConfigHash` is a settable mock for what
      // `/api/train` reads via `getCurrentConfigHash` to capture the
      // spawned-config snapshot.
      const subs = new Set<(e: HmrEvent) => void>();
      let currentConfigHash: string | null = initialConfigHash;
      // Match the real coordinator's behaviour: a stable artefact
      // fingerprint at spawn time. Tests that exercise the
      // pre-ready-spawn path (configHash null, then a real hash)
      // can override via `setArtifactHash`.
      let currentArtifactHash: string | null = "fake-artefact-hash";
      let currentArtifactContentHash: string | null =
        "fake-artefact-content-hash";
      let lastEventType: HmrEvent["type"] | null = null;
      const coordinator: HmrCoordinator = {
        subscribe(fn) {
          subs.add(fn);
          return () => {
            subs.delete(fn);
          };
        },
        getCurrentConfigHash() {
          return currentConfigHash;
        },
        getCurrentArtifactHash() {
          return currentArtifactHash;
        },
        getCurrentArtifactContentHash() {
          return currentArtifactContentHash;
        },
        getLastEventType() {
          return lastEventType;
        },
        async dispose() {
          subs.clear();
        },
      };
      return {
        coordinator,
        emit(event: HmrEvent) {
          // Track the latest event type so `getLastEventType()`
          // mirrors the real coordinator's `lastEvent?.type` —
          // the `/api/manifest` HMR-error gate consults this.
          lastEventType = event.type;
          for (const fn of subs) fn(event);
        },
        setConfigHash(hash: string | null) {
          currentConfigHash = hash;
        },
        setArtifactHash(hash: string | null) {
          currentArtifactHash = hash;
        },
        setArtifactContentHash(hash: string | null) {
          currentArtifactContentHash = hash;
        },
        setLastEventType(t: HmrEvent["type"] | null) {
          lastEventType = t;
        },
        get subscriberCount() {
          return subs.size;
        },
      };
    }

    it("is unregistered when no hmr coordinator is supplied", async () => {
      const app = build();
      const res = await app.request("/api/dev/events", {
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
        },
      });
      expect(res.status).toBe(404);
    });

    it("rejects /api/dev/events without a token", async () => {
      const fake = fakeHmr();
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fake.coordinator,
      });
      const res = await app.request("/api/dev/events", {
        headers: { host: "127.0.0.1:4000" },
      });
      expect(res.status).toBe(403);
    });

    it("accepts the studio token via ?studioToken= for the dev event stream", async () => {
      const fake = fakeHmr();
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fake.coordinator,
      });
      // The server subscribes to the HMR coordinator exactly once at
      // build time (so multiple SSE clients don't fan signal dispatch
      // out to the same child N times). Per-client cleanup happens on
      // the SSE listener set, not against the coordinator — so
      // `fake.subscriberCount` stays at 1 across the connection
      // lifecycle. We assert that here rather than expect the
      // pre-refactor "0 after cancel" behaviour.
      expect(fake.subscriberCount).toBe(1);
      const res = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "127.0.0.1:4000" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      await reader.cancel();
      // Cancel doesn't unsubscribe the server-level listener; emitting
      // an event after cancel must still be safe (the SSE listener that
      // was registered for this connection is removed, so the
      // controller-closed try/catch in `send` is never exercised).
      expect(() =>
        fake.emit({
          type: "rebuild",
          outFile: "/tmp/x",
          hash: "h",
          configHash: null,
          trainerName: null,
        }),
      ).not.toThrow();
    });

    it("rejects /api/dev/events when host header is non-loopback", async () => {
      const fake = fakeHmr();
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fake.coordinator,
      });
      const res = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "evil.example.com" } },
      );
      expect(res.status).toBe(403);
    });

    it("dispatches HMR signals exactly once per rebuild regardless of connected SSE client count", async () => {
      // Regression: previously each `/api/dev/events` connection
      // attached its own `hmr.subscribe(...)` callback, so a rebuild
      // with N open Studio tabs fanned out into N × SIGUSR2 / N ×
      // SIGTERM per child. The runner's shutdown handler interprets a
      // *second* SIGTERM as the emergency `exit(143)` fast-path, which
      // would defeat checkpoint preservation. The server now subscribes
      // to the coordinator exactly once and broadcasts the augmented
      // payload to every SSE client; we assert that subscriber count
      // doesn't grow when extra connections are opened.
      const fake = fakeHmr();
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fake.coordinator,
      });
      expect(fake.subscriberCount).toBe(1);
      const r1 = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "127.0.0.1:4000" } },
      );
      const r2 = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "127.0.0.1:4000" } },
      );
      // Pump the streams so their `start()` runs, registering the
      // per-client SSE listeners on the server side.
      const reader1 = r1.body!.getReader();
      const reader2 = r2.body!.getReader();
      // Even with two concurrent SSE clients the HMR coordinator still
      // sees exactly the one server-level subscriber.
      expect(fake.subscriberCount).toBe(1);
      await reader1.cancel();
      await reader2.cancel();
      expect(fake.subscriberCount).toBe(1);
    });

    it("/api/train cancel still fires cloud cancel POST + SIGKILL even when HMR has already requested early-stop", async () => {
      // Regression: the cancel handler used to short-circuit
      // (`if (earlyStopInFlight) return;`) when HMR's
      // `dispatchRebuild` had already SIGTERMed the child for a
      // graceful checkpoint-wait early-stop. That gate was added
      // to avoid a second SIGTERM piling on top of the first
      // (which would have triggered the runner's `exit(143)`
      // emergency path and broken cloud cancel POSTing). With
      // SIGKILL replacing the user-stop SIGTERM, the
      // double-signal worry no longer applies — and the gate
      // turned a Stop click during HMR's graceful window into a
      // total no-op, leaving the run alive until checkpoint /
      // 5-min timeout. Manual stop now overrides HMR's graceful
      // path: server POSTs cloud cancel + SIGKILLs the
      // subprocess regardless of `isEarlyStopRequested`.
      await writeCredentials(ANON_CREDS);
      await writeState(
        {
          orgSlug: "manual-override-org",
          projectSlug: "manual-override-project",
          projectId: "p-manual",
        },
        trainCwd,
      );
      const FAKE_JOB_ID = "manual-stop-during-hmr";
      const fakeBin = join(trainCwd, "manual-during-hmr-bin.mjs");
      // SIGTERM no-op so HMR's graceful SIGTERM doesn't terminate
      // the bin — we need it alive so the subsequent manual
      // cancel actually has something to SIGKILL.
      writeFileSync(
        fakeBin,
        `process.stdout.write("Started job ${FAKE_JOB_ID}\\n");
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 60_000);
        `,
      );
      let cancelHits: Array<{ url: string }> = [];
      const ORIG_FETCH = globalThis.fetch;
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "POST" && /\/v1\/jobs\/[^/]+\/cancel/.test(url)) {
          cancelHits.push({ url });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      try {
        const fake = fakeHmr("h1");
        const app = buildStudioApp({
          baseUrl: "http://mock-cloud-api",
          assetsDir,
          autoAnonymous: false,
          studioToken: STUDIO_TOKEN,
          cwd: trainCwd,
          binPath: fakeBin,
          hmr: fake.coordinator,
        });
        const trainRes = await app.request("/api/train", {
          method: "POST",
          headers: {
            host: "127.0.0.1:4000",
            "x-arkor-studio-token": STUDIO_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        expect(trainRes.status).toBe(200);
        const pid = Number(trainRes.headers.get("x-arkor-train-pid"));
        // Drain until the parser has recorded the job id.
        const reader = trainRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!buf.includes(`Started job ${FAKE_JOB_ID}`)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        // Emit an HMR mismatch — server's dispatch SIGTERMs the
        // bin and sets `earlyStopRequested = true` on the entry.
        // The bin's SIGTERM no-op keeps it alive so the manual
        // cancel below has a target.
        fake.emit({
          type: "ready",
          outFile: "/tmp/x.mjs",
          hash: "abc",
          configHash: "h2", // mismatch with spawn-time "h1"
          trainerName: "t",
        });
        // Let the dispatch run + signal land.
        await new Promise((r) => setTimeout(r, 80));

        // Manual cancel — old code would have early-returned; new
        // code POSTs cloud cancel + SIGKILLs.
        await reader.cancel();
        await new Promise((r) => setTimeout(r, 250));

        // Cloud cancel POST landed for the right job.
        expect(cancelHits).toHaveLength(1);
        expect(cancelHits[0]?.url).toContain(`/v1/jobs/${FAKE_JOB_ID}/cancel`);
        // And the bin is dead — SIGKILL bypassed its SIGTERM
        // no-op (which had been masking HMR's earlier SIGTERM).
        let probeError: NodeJS.ErrnoException | null = null;
        try {
          process.kill(pid, 0);
        } catch (e) {
          probeError = e as NodeJS.ErrnoException;
        }
        expect(probeError?.code).toBe("ESRCH");
      } finally {
        globalThis.fetch = ORIG_FETCH;
      }
    });

    it("dispatches HMR signals for `ready` events too (not only `rebuild`)", async () => {
      // Regression: previously the dispatch fired only on
      // `rebuild`, so a child started via `/api/train` *before*
      // the watcher's first successful BUNDLE_END (the very first
      // success is broadcast as `ready`, and the entry-wait recovery
      // path also emits `ready`) would never get SIGUSR2/SIGTERM-
      // routed when that build eventually landed — leaving it
      // running a stale or empty artifact. Exercise the contract
      // here by spawning a hanging child, then emitting `ready`
      // with a different `configHash`; dispatch should pick up the
      // mismatch and surface restart targets in the SSE frame.
      await writeCredentials(ANON_CREDS);
      const hangingBin = join(trainCwd, "hanging-bin.mjs");
      // setInterval keeps the event loop alive without trapping
      // SIGTERM, so dispatch's kill returns the child to the OS.
      writeFileSync(hangingBin, "setInterval(() => {}, 1000);\n");

      const fake = fakeHmr("h1");
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        binPath: hangingBin,
        hmr: fake.coordinator,
      });

      const trainRes = await app.request("/api/train", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4000",
          "x-arkor-studio-token": STUDIO_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(trainRes.status).toBe(200);
      const pid = Number(trainRes.headers.get("x-arkor-train-pid"));

      const sseRes = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "127.0.0.1:4000" } },
      );
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();

      try {
        // `configHash` = "h2" mismatches the spawn-time "h1" → SIGTERM
        // path → `restartTargets` should be non-empty in the SSE frame.
        fake.emit({
          type: "ready",
          outFile: "/tmp/x.mjs",
          hash: "abc",
          configHash: "h2",
          trainerName: "t",
        });

        let received = "";
        while (!received.includes("\n\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
        expect(received).toContain("event: ready");
        // The dispatch augmentation marker — would be absent if the
        // `event.type !== "error"` filter regressed back to gating on
        // `=== "rebuild"`, and `restart`/`restartTargets` would never
        // appear on a `ready` frame.
        expect(received).toContain('"restart":true');
        expect(received).toContain(`"pid":${pid}`);
      } finally {
        await reader.cancel();
        // Best-effort cleanup if dispatch's SIGTERM hasn't reaped
        // the child yet (signal delivery is async in the kernel).
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });

    it("forwards rebuild events as SSE frames", async () => {
      const fake = fakeHmr();
      const app = buildStudioApp({
        baseUrl: "http://mock",
        assetsDir,
        autoAnonymous: false,
        studioToken: STUDIO_TOKEN,
        cwd: trainCwd,
        hmr: fake.coordinator,
      });
      const res = await app.request(
        `/api/dev/events?studioToken=${encodeURIComponent(STUDIO_TOKEN)}`,
        { headers: { host: "127.0.0.1:4000" } },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      fake.emit({ type: "ready", outFile: "/tmp/x", hash: "abc" });
      // Read chunks until we have at least one full SSE frame.
      let received = "";
      while (!received.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      expect(received).toContain("event: ready");
      expect(received).toContain('"outFile":"/tmp/x"');
      await reader.cancel();
    });
  });
});
