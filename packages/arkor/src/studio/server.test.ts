import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStudioApp } from "./server";
import { writeCredentials } from "../core/credentials";

let fakeHome: string;
let assetsDir: string;
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-studio-test-"));
  process.env.HOME = fakeHome;
  assetsDir = mkdtempSync(join(tmpdir(), "arkor-studio-assets-"));
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<title>Studio</title>");
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
});

describe("Studio server", () => {
  it("serves index.html at /", async () => {
    const app = buildStudioApp({
      baseUrl: "http://mock",
      assetsDir,
      autoAnonymous: false,
    });
    const res = await app.request("/", {
      headers: { host: "127.0.0.1:4000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<title>Studio</title>");
  });

  it("rejects non-loopback API requests", async () => {
    const app = buildStudioApp({
      baseUrl: "http://mock",
      assetsDir,
      autoAnonymous: false,
    });
    const res = await app.request("/api/credentials", {
      headers: { host: "192.168.1.5:4000" },
    });
    expect(res.status).toBe(403);
  });

  it("returns the current credential token", async () => {
    await writeCredentials({
      mode: "anon",
      token: "tok",
      anonymousId: "anon-id",
      arkorCloudApiUrl: "http://mock",
      orgSlug: "anon-org",
    });
    const app = buildStudioApp({
      baseUrl: "http://mock",
      assetsDir,
      autoAnonymous: false,
    });
    const res = await app.request("/api/credentials", {
      headers: { host: "127.0.0.1:4000" },
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
});
