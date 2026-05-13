// E2E coverage for `arkor whoami`'s interaction with the cloud-api SDK
// version gate. Spawns the built `arkor` binary against an in-process fake
// HTTP server and asserts on the surfaced 426 / Deprecation behaviour.
//
// Path-based pm detection (heuristics on `process.argv[1]`) is unit-tested
// in `packages/arkor/src/core/upgrade-hint.test.ts`. Here we drive the
// **user-agent** branch by setting `npm_config_user_agent` on the spawn,
// since `argv[1]` for the spawned child is always the dist bin and never a
// pnpm/bun/yarn-shaped global path.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli } from "./spawn-cli";

interface FakeServer {
  port: number;
  close: () => Promise<void>;
  setHandler: (
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) => void;
  /** All requests received during this server's lifetime. */
  requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"] }>;
}

async function startFakeCloudApi(): Promise<FakeServer> {
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (
    _req,
    res,
  ) => {
    res.statusCode = 404;
    res.end("not found");
  };
  const requests: FakeServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen addr");
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    setHandler: (h) => {
      handler = h;
    },
    requests,
  };
}

function seedAnonCreds(home: string, baseUrl: string): void {
  const dir = join(home, ".arkor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      mode: "anon",
      token: "fake-anon-token-for-e2e",
      anonymousId: "anon-e2e-test",
      arkorCloudApiUrl: baseUrl,
      orgSlug: "anon-e2e",
    }),
    { mode: 0o600 },
  );
}

const UPGRADE_BODY = {
  error: "sdk_version_unsupported",
  currentVersion: "1.3.5",
  supportedRange: "^1.4.0 || >=2.1.0",
  upgrade: "npm install -g arkor@latest",
};

let server: FakeServer;
let home: string;
let baseUrl: string;

beforeEach(async () => {
  server = await startFakeCloudApi();
  home = makeTempDir("arkor-whoami-e2e-");
  baseUrl = `http://127.0.0.1:${server.port}`;
  seedAnonCreds(home, baseUrl);
});

afterEach(async () => {
  await server.close();
  cleanup(home);
});

describe("arkor whoami × SDK version gate (E2E)", () => {
  it("renders the npm install command on 426 when invoked under npm", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(UPGRADE_BODY));
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "npm/10.5.0 node/v22 linux x64",
    });

    // 426 is a hard block; the CLI must exit non-zero so scripts that gate
    // on `arkor whoami` don't silently proceed past an unsupported SDK.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Arkor SDK 1.3.5 is no longer supported");
    expect(result.stderr).toContain("^1.4.0 || >=2.1.0");
    expect(result.stderr).toContain("npm install -g arkor@latest");
    // The misleading "Token may be expired" fallback should NOT show on 426.
    expect(result.stdout).not.toContain("Token may be expired");
  });

  it("substitutes the pnpm command when invoked under pnpm", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(UPGRADE_BODY));
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "pnpm/8.15.0 npm/? node/v22 linux x64",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pnpm add -g arkor@latest");
    // Make sure we replaced rather than appended the npm hint.
    expect(result.stderr).not.toContain("npm install -g arkor@latest");
  });

  it("substitutes the bun command when invoked under bun", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(UPGRADE_BODY));
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "bun/1.1.0",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bun add -g arkor@latest");
  });

  it("substitutes the yarn command when invoked under yarn", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(UPGRADE_BODY));
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "yarn/1.22.19 npm/? node/v22 linux x64",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("yarn global add arkor@latest");
  });

  it("still exits 1 on 426 when the body is missing or non-JSON", async () => {
    // Regression guard: a 426 with an unfamiliar body (empty here, e.g. a
    // proxy stripped it) must still hard-block. Earlier the formatter
    // returned `null` for an unparseable body, which silently fell through
    // to the "Token may be expired" branch and exited 0 — so scripts gating
    // on `arkor whoami` would proceed past an unsupported SDK.
    server.setHandler((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "text/plain");
      res.end("not really json");
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "pnpm/8.15.0 npm/? node/v22 linux x64",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Arkor SDK is no longer supported");
    expect(result.stderr).toContain("pnpm add -g arkor@latest");
    expect(result.stdout).not.toContain("Token may be expired");
  });

  it("forwards the X-Arkor-Client header on every request", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ user: { id: "u1" }, orgs: [] }));
    });

    await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
    });

    const meCall = server.requests.find((r) => r.url === "/v1/me");
    expect(meCall).toBeDefined();
    const header = meCall?.headers["x-arkor-client"];
    expect(typeof header).toBe("string");
    expect(header as string).toMatch(/^arkor\/\d+\.\d+\.\d+/);
  });

  it("surfaces a deprecation warning with pm-aware upgrade hint when 200 + Deprecation header", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("Deprecation", "true");
      res.setHeader(
        "Warning",
        '299 - "Arkor SDK 0.0.2-alpha.2 is deprecated; supported range: >=2.0.0"',
      );
      res.end(
        JSON.stringify({
          user: { id: "u1", email: null },
          orgs: [{ id: "o1", slug: "anon-e2e", name: "Test" }],
        }),
      );
    });

    const result = await runCli(ARKOR_BIN, ["whoami"], home, {
      HOME: home,
      ARKOR_CLOUD_API_URL: baseUrl,
      npm_config_user_agent: "pnpm/8.15.0 npm/? node/v22 linux x64",
    });

    expect(result.code).toBe(0);
    // Body still rendered.
    expect(result.stdout).toContain("u1");
    // Warning surfaces somewhere on the streams. clack `log.warn` writes to
    // stdout; tolerate both to avoid coupling the test to clack internals.
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("deprecated");
    expect(combined).toContain("pnpm add -g arkor@latest");
  });
});
