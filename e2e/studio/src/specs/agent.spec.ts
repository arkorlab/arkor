import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ARKOR_BIN } from "../harness/bins";
import { expect, test } from "../harness/fixture";

// Agent mode (`arkor dev --agent`, ENG-967): the browser-free contract a
// coding agent relies on. Covers the stdout session-file line, the JSON
// session file itself (shape + POSIX modes), the token-guarded
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
    expect(sessionFile!.startsWith(agentDir)).toBe(true);
    const payload = readSession(sessionFile!);
    // The CLI prints/binds 127.0.0.1 but displays localhost; the session
    // file carries the displayed URL.
    const port = new URL(agentStudio.url).port;
    expect(payload.url).toBe(`http://localhost:${port}`);
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

  test("GET /api/status answers the session-file token with safe agent metadata", async ({
    agentStudio,
  }) => {
    const payload = readSession(agentStudio.sessionFile!);
    const res = await fetch(`${agentStudio.url}/api/status`, {
      headers: { "X-Arkor-Studio-Token": payload.token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.server).toBe("arkor-studio");
    expect(body.mode).toBe("agent");
    expect(body.endpoints).toContain("POST /api/train");
    // Safe by contract: the CSRF token must never round-trip in the body.
    expect(JSON.stringify(body)).not.toContain(payload.token);
  });

  test("GET /api/status still 403s without the token header", async ({
    agentStudio,
  }) => {
    const res = await fetch(`${agentStudio.url}/api/status`);
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
    // The agent session owns the port and wrote ~/.arkor/studio-token
    // (fixture HOME); the plain launch probes /api/status with it,
    // confirms the occupant is an Arkor Studio, prints the URL, and
    // exits 0 instead of EADDRINUSE-failing.
    const port = new URL(agentStudio.url).port;
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      const lower = k.toLowerCase();
      if (
        lower.startsWith("npm_config_") ||
        lower.startsWith("pnpm_config_") ||
        lower === "claudecode"
      ) {
        continue;
      }
      env[k] = v;
    }
    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [ARKOR_BIN, "dev", "--port", port],
          {
            cwd: fixturePaths.projectDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...env,
              CI: "1",
              HOME: fixturePaths.home,
              USERPROFILE: fixturePaths.home,
              ARKOR_CLOUD_API_URL: cloudApi.baseUrl,
              ARKOR_TELEMETRY_DISABLED: "1",
              npm_config_user_agent: "",
            },
          },
        );
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
          stdout += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stdout });
        });
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Arkor Studio already running on http://localhost:${port}`,
    );
    // The running agent session is untouched.
    const res = await fetch(`${agentStudio.url}/api/status`, {
      headers: {
        "X-Arkor-Studio-Token": readSession(agentStudio.sessionFile!).token,
      },
    });
    expect(res.status).toBe(200);
  });
});
