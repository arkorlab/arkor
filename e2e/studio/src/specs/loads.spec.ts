import { request as httpRequest } from "node:http";
import { expect, test } from "../harness/fixture";

/**
 * Issue a request with a manually-controlled `Host` header. `fetch()` /
 * undici resets Host to match the connection target for security, which
 * is exactly what we *don't* want when testing the Studio server's
 * DNS-rebinding guard. `node:http.request` honours whatever Host we
 * pass — perfect for forging a non-loopback Host while staying on
 * 127.0.0.1.
 */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Boot path + CSRF / host-header guards. These are the contracts
// `arkor dev` advertises: same-origin SPA + meta-tag token + 403 on
// missing token + 403 on non-loopback Host header.

test.describe("Studio boot + auth contract", () => {
  test("serves index.html with the per-launch meta token", async ({
    page,
    studio,
  }) => {
    await page.goto(studio.url);
    await expect(page).toHaveTitle(/Arkor Studio/);
    const tokens = page.locator('meta[name="arkor-studio-token"]');
    await expect(tokens).toHaveCount(1);
    const content = await tokens.getAttribute("content");
    expect(content).toBe(studio.token);
  });

  test("/api/credentials returns 200 with the expected token header", async ({
    studio,
  }) => {
    const res = await fetch(`${studio.url}/api/credentials`, {
      headers: { "X-Arkor-Studio-Token": studio.token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("anon");
    expect(body.orgSlug).toBe("studio-e2e-org");
    expect(body.projectSlug).toBe("studio-e2e-project");
    // Server returns the cloud-api token (not the studio CSRF token);
    // just assert it's a non-empty string.
    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe("");
  });

  test("/api/credentials returns 403 without the token header", async ({
    studio,
  }) => {
    // Regression guard for packages/arkor/src/studio/server.ts middleware
    // — a missing or wrong token must reject before any handler runs.
    const res = await fetch(`${studio.url}/api/credentials`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/studio token/i);
  });

  test("/api/credentials with a wrong-length token also 403s", async ({
    studio,
  }) => {
    const res = await fetch(`${studio.url}/api/credentials`, {
      headers: { "X-Arkor-Studio-Token": "way-too-short" },
    });
    expect(res.status).toBe(403);
  });

  test("non-loopback Host header is rejected (DNS rebinding guard)", async ({
    studio,
  }) => {
    // Host-header guard runs before the token check, so even with the
    // right token + a forged Host the server should 403. Use rawGet
    // because fetch/undici overwrite Host to match the URL target.
    const { status } = await rawGet(`${studio.url}/api/credentials`, {
      "X-Arkor-Studio-Token": studio.token,
      Host: "evil.example.com",
    });
    expect(status).toBe(403);
  });
});
