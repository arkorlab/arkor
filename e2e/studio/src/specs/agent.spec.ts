import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "../harness/fixture";
import { spawnDevToExit } from "../harness/studioServer";

// Agent mode (`arkor dev --agent`, ENG-967): the browser-free contract a
// coding agent relies on. Covers the stdout session-file line, the JSON
// session file itself (shape + POSIX modes), the token-exempt
// GET /api/status probe, the SPA staying reachable for humans, SIGINT
// cleanup, and a second plain `arkor dev` connecting to the running
// instance instead of failing on the busy port.

interface SessionPayload {
  token: string;
  url: string;
  port: number;
  pid: number;
}

function readSession(sessionFile: string): SessionPayload {
  return JSON.parse(readFileSync(sessionFile, "utf8")) as SessionPayload;
}

test.describe("Agent mode contract", () => {
  test("writes the JSON session file under .arkor/agent/ with tight modes", async ({
    agentStudio,
    fixturePaths,
  }) => {
    const sessionFile = agentStudio.sessionFile;
    expect(sessionFile).toBeDefined();
    const agentDir = join(fixturePaths.projectDir, ".arkor", "agent");
    // Exact parent-dir match (not a loose prefix, which would also accept a
    // sibling like `.arkor/agentX`).
    expect(dirname(sessionFile!)).toBe(agentDir);
    const payload = readSession(sessionFile!);
    // The session file carries the agent-facing 127.0.0.1 URL (the literal the
    // server bound), which is exactly what the harness connects to.
    const port = new URL(agentStudio.url).port;
    expect(payload.url).toBe(`http://127.0.0.1:${port}`);
    expect(payload.url).toBe(agentStudio.url);
    expect(String(payload.port)).toBe(port);
    expect(Number.isInteger(payload.pid)).toBe(true);
    // The file token is the same per-launch CSRF token the SPA reads from
    // its meta tag.
    expect(payload.token).toBe(agentStudio.token);
    if (process.platform !== "win32") {
      expect(statSync(agentDir).mode & 0o777).toBe(0o700);
      expect(statSync(sessionFile!).mode & 0o777).toBe(0o600);
    }
  });

  test("GET /api/status is token-exempt and returns safe agent metadata", async ({
    agentStudio,
  }) => {
    // No token header: /api/status is the one token-exempt route (so the
    // port-collision probe can confirm the occupant without disclosing the
    // CSRF token). It stays secrets-free.
    const res = await fetch(`${agentStudio.url}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.server).toBe("arkor-studio");
    expect(body.mode).toBe("agent");
    // The echoed url is the agent-facing 127.0.0.1 literal (not localhost).
    expect(body.url).toBe(agentStudio.url);
    expect(body.url).toBe(`http://127.0.0.1:${new URL(agentStudio.url).port}`);
    expect(body.endpoints).toContain("POST /api/train");
    // Safe by contract: the CSRF token must never round-trip in the body.
    expect(JSON.stringify(body)).not.toContain(
      readSession(agentStudio.sessionFile!).token,
    );
  });

  test("a token-guarded route still 403s without the token header", async ({
    agentStudio,
  }) => {
    // The token exemption is scoped to /api/status only; the rest of /api/*
    // still requires the header.
    const res = await fetch(`${agentStudio.url}/api/credentials`);
    expect(res.status).toBe(403);
  });

  test("the Studio SPA stays reachable in agent mode (humans keep browser access)", async ({
    agentStudio,
    page,
  }) => {
    await page.goto(agentStudio.url);
    await expect(page).toHaveTitle(/Arkor Studio/);
    const tokens = page.locator('meta[name="arkor-studio-token"]');
    await expect(tokens).toHaveCount(1);
  });

  test("SIGINT removes the session file", async ({ agentStudio }) => {
    // Node's Windows signal emulation terminates the child forcefully;
    // the dev.ts SIGINT handler never runs, so the unlink cannot happen.
    test.skip(
      process.platform === "win32",
      "Windows signal emulation kills the child without running handlers",
    );
    const sessionFile = agentStudio.sessionFile!;
    expect(existsSync(sessionFile)).toBe(true);
    await agentStudio.kill();
    expect(existsSync(sessionFile)).toBe(false);
  });

  test("a second plain `arkor dev` on the same port connects and exits 0", async ({
    agentStudio,
    fixturePaths,
    cloudApi,
  }) => {
    // The agent session owns the port and serves this project; the plain
    // launch probes 127.0.0.1/api/status (no token), confirms the occupant
    // is an Arkor Studio serving the SAME project, prints the URL, and
    // exits 0 instead of EADDRINUSE-failing.
    const port = new URL(agentStudio.url).port;
    const result = await spawnDevToExit(
      {
        home: fixturePaths.home,
        projectDir: fixturePaths.projectDir,
        cloudApiUrl: cloudApi.baseUrl,
      },
      ["--port", port],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Arkor Studio already running on http://localhost:${port}`,
    );
    // The running agent session is untouched.
    const res = await fetch(`${agentStudio.url}/api/status`);
    expect(res.status).toBe(200);
  });

  test("a plain `arkor dev` for a DIFFERENT project does not adopt this port", async ({
    agentStudio,
    fixturePaths,
    cloudApi,
  }) => {
    // Project-match guard: an occupant serving another project must NOT be
    // adopted. Spawn from a different cwd (the fixture HOME dir, which is not
    // the project root) targeting the busy port; the probe's cwd check fails,
    // so the launch falls back to the hard port-in-use error.
    const port = new URL(agentStudio.url).port;
    const result = await spawnDevToExit(
      {
        home: fixturePaths.home,
        projectDir: fixturePaths.home,
        cloudApiUrl: cloudApi.baseUrl,
      },
      ["--port", port],
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`Port ${port} is already in use`);
  });
});
