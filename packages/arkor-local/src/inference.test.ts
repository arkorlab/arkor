import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InferenceManager } from "./inference";

import type { ChildProcess } from "node:child_process";
import type { LocalTrainingBackend } from "./backends/types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/fake-openai-server.mjs",
);

let tmp: string;
let manager: InferenceManager | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "arkor-local-inference-"));
  manager = null;
});

afterEach(async () => {
  await manager?.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

function fakeServerBackend(extraArgs: string[] = []): LocalTrainingBackend {
  return {
    id: "fake",
    displayName: "Fake backend",
    preflight: () => Promise.resolve({ ok: true }),
    validateConfig: () => ({ ok: true }),
    buildTrainRun: () => {
      throw new Error("not under test");
    },
    inference: {
      buildServerSpec: ({ port }) => ({
        command: process.execPath,
        argv: [FIXTURE, "--port", String(port), ...extraArgs],
      }),
    },
  };
}

function makeManager(
  backend: LocalTrainingBackend,
  options: { readinessTimeoutMs?: number; idleShutdownMs?: number } = {},
): { manager: InferenceManager; spawned: ChildProcess[] } {
  const spawned: ChildProcess[] = [];
  const spawnImpl: typeof spawn = ((
    command: string,
    args: string[],
    opts: object,
  ) => {
    const child = spawn(command, args, opts as Parameters<typeof spawn>[2]);
    spawned.push(child);
    return child;
  }) as typeof spawn;
  const created = new InferenceManager({
    backend,
    shimDir: "/unused-shim-dir",
    logFile: join(tmp, "inference.log"),
    spawnImpl,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 30_000,
    idleShutdownMs: options.idleShutdownMs ?? 60_000,
  });
  manager = created;
  return { manager: created, spawned };
}

const CHAT_ARGS = {
  model: "mlx-community/tiny",
  adapterPath: null,
  body: { messages: [{ role: "user", content: "hi" }], stream: true },
  signal: new AbortController().signal,
};

describe("InferenceManager", () => {
  it("lazily starts the child and streams the OpenAI response through", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend());
    const res = await m.handleChat(CHAT_ARGS);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"delta":{"content":"hello"}');
    expect(text).toContain("data: [DONE]");
    expect(spawned).toHaveLength(1);
  });

  it("supports non-streaming requests via passthrough", async () => {
    const { manager: m } = makeManager(fakeServerBackend());
    const res = await m.handleChat({
      ...CHAT_ARGS,
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe("hello from fake");
  });

  it("reuses the child for the same (model, adapter) key", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend());
    await m.handleChat(CHAT_ARGS);
    await m.handleChat(CHAT_ARGS);
    expect(spawned).toHaveLength(1);
  });

  it("replaces the child when the key changes", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend());
    await m.handleChat(CHAT_ARGS);
    await m.handleChat({ ...CHAT_ARGS, adapterPath: "/some/adapter" });
    expect(spawned).toHaveLength(2);
    // The first child was stopped as part of the swap.
    await waitFor(
      () => spawned[0]?.exitCode !== null || spawned[0]?.signalCode !== null,
    );
  });

  it("respawns after the child dies", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend());
    await m.handleChat(CHAT_ARGS);
    const first = firstSpawned(spawned);
    first.kill("SIGKILL");
    await waitFor(() => first.exitCode !== null || first.signalCode !== null);
    // Give the close handler a tick to clear `current`.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await m.handleChat(CHAT_ARGS);
    expect(res.status).toBe(200);
    expect(spawned).toHaveLength(2);
  });

  it("returns 502 with the log path when readiness times out", async () => {
    const { manager: m } = makeManager(fakeServerBackend(["--never-listen"]), {
      readinessTimeoutMs: 600,
    });
    const res = await m.handleChat(CHAT_ARGS);
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("failed to start");
    expect(error).toContain("inference.log");
  });

  it("returns 499 when the requester aborted", async () => {
    const { manager: m } = makeManager(fakeServerBackend());
    const controller = new AbortController();
    controller.abort();
    const res = await m.handleChat({ ...CHAT_ARGS, signal: controller.signal });
    expect(res.status).toBe(499);
  });

  it("stops the child after the idle timeout", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend(), {
      idleShutdownMs: 200,
    });
    await m.handleChat(CHAT_ARGS);
    const child = firstSpawned(spawned);
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("closeAll stops the child", async () => {
    const { manager: m, spawned } = makeManager(fakeServerBackend());
    await m.handleChat(CHAT_ARGS);
    await m.closeAll();
    const child = firstSpawned(spawned);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

function firstSpawned(spawned: ChildProcess[]): ChildProcess {
  const child = spawned.at(0);
  if (!child) throw new Error("no child spawned");
  return child;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
