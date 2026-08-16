import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { loadLocalRuntime } from "../local-runtime-loader";

import { runStart } from "./start";

vi.mock("../local-runtime-loader", () => ({
  loadLocalRuntime: vi.fn(),
}));

let cwd: string;
const ORIG_CWD = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-start-test-"));
  // runTrainer falls back to process.cwd() when given a relative entry; we
  // pass an absolute path through runStart, but the bundle-and-import path
  // still resolves CWD-relative imports. Pin it to the temp dir.
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(cwd, { recursive: true, force: true });
});

const FAKE_MANIFEST = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: "run",
    start: async () => ({ jobId: "j1" }),
    wait: async () => ({
      job: {
        id: "j1",
        orgId: "o",
        projectId: "p",
        name: "run",
        status: "completed",
        config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
        createdAt: "2026-01-01",
      },
      artifacts: [],
    }),
    cancel: async () => {},
  },
});
`;

describe("runStart", () => {
  it("auto-builds when the artifact is missing, then runs the trainer", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);

    try {
      await runStart({ cwd });
    } finally {
      spy.mockRestore();
    }

    // Auto-built the artifact on first run.
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
    // Trainer.start() and .wait() both ran.
    const stdout = writes.join("");
    expect(stdout).toContain("Started job j1");
    expect(stdout).toContain("status=completed");
  });

  it("skips the build step when the artifact already exists and no entry override is given", async () => {
    // Branch coverage for `Boolean(opts.entry) || !existsSync(outFile)`:
    // the path where both halves are false. Pre-build the artifact, then
    // confirm runStart imports it without triggering esbuild again.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    // First call builds normally.
    await runStart({ cwd });
    // Damage the source so a rebuild would crash if it ran. With the
    // skip-build branch, the helper imports the cached artifact and the
    // bad source is never re-bundled.
    writeFileSync(join(cwd, "src/arkor/index.ts"), "syntax error <<<");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    try {
      await expect(runStart({ cwd })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("Started job j1");
  });

  it("accepts an absolute outDir without joining it under cwd", async () => {
    // Branch coverage for `isAbsolute(outDirRel) ? outDirRel : resolve(...)`.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    const absOut = join(cwd, "abs-out");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    try {
      await runStart({ cwd, outDir: absOut });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(absOut, "index.mjs"))).toBe(true);
  });

  it("falls back to process.cwd() when no cwd is provided", async () => {
    // Branch coverage for the cwd default. process.chdir is already pinned
    // to the test's temp dir in beforeEach, so omitting the option lets
    // the helper read it from there.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    try {
      await runStart({});
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
  });

  it("rebuilds when an explicit entry is provided", async () => {
    const altEntry = join(cwd, "alt-entry.ts");
    writeFileSync(
      altEntry,
      FAKE_MANIFEST.replace(/jobId: "j1"/, 'jobId: "alt"'),
    );

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    // Use a dedicated outDir so the in-process module cache doesn't return a
    // stale import (each `arkor start` invocation is a fresh process in real
    // usage, but tests share one Node ESM cache).
    try {
      await runStart({
        cwd,
        entry: "alt-entry.ts",
        outDir: ".arkor/build-alt",
      });
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(join(cwd, ".arkor/build-alt/index.mjs"))).toBe(true);
    // The alt entry's jobId surfaces, proving the rebuild used the override.
    expect(writes.join("")).toContain("Started job alt");
  });
});

describe("runStart --local", () => {
  // A manifest that captures the env hand-off at trainer start time,
  // proving the variables were set BEFORE the artifact's dynamic import.
  const ENV_ECHO_MANIFEST = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: "run",
    start: async () => {
      console.log(
        "[env-echo] url=" + process.env.ARKOR_LOCAL_SERVER_URL +
        " token=" + process.env.ARKOR_LOCAL_SERVER_TOKEN,
      );
      return { jobId: "j-local" };
    },
    wait: async () => ({
      job: {
        id: "j-local",
        orgId: "local",
        projectId: "local",
        name: "run",
        status: "completed",
        config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
        createdAt: "2026-01-01",
      },
      artifacts: [],
    }),
    cancel: async () => {},
  },
});
`;

  afterEach(() => {
    vi.mocked(loadLocalRuntime).mockReset();
    delete process.env.ARKOR_LOCAL_SERVER_URL;
    delete process.env.ARKOR_LOCAL_SERVER_TOKEN;
  });

  function mockRuntime() {
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:43210",
      token: "local-token-abcdef0123456789",
      backend: { id: "mlx", displayName: "MLX (Apple Silicon)" },
      close,
    }));
    vi.mocked(loadLocalRuntime).mockResolvedValue({ startServer });
    return { close, startServer };
  }

  it("boots the local server, sets the env hand-off before import, and cleans up", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), ENV_ECHO_MANIFEST);
    const { close, startServer } = mockRuntime();

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await runStart({ cwd, local: true, backend: "mlx" });
    } finally {
      logSpy.mockRestore();
    }

    expect(startServer).toHaveBeenCalledWith({ cwd, backendId: "mlx" });
    const output = logs.join("\n");
    // The trainer observed the hand-off at start() time.
    expect(output).toContain("[env-echo] url=http://127.0.0.1:43210");
    expect(output).toContain("token=local-token-abcdef0123456789");
    // The CLI announced the backend.
    expect(output).toContain("MLX (Apple Silicon)");
    // Server closed and env removed (not left as the string "undefined").
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.env.ARKOR_LOCAL_SERVER_URL).toBeUndefined();
    expect(process.env.ARKOR_LOCAL_SERVER_TOKEN).toBeUndefined();
  });

  it("closes the local server even when the trainer run fails", async () => {
    // No src/arkor/index.ts: the build step throws.
    const { close } = mockRuntime();
    await expect(runStart({ cwd, local: true })).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.env.ARKOR_LOCAL_SERVER_URL).toBeUndefined();
  });

  it("reuses an existing env hand-off instead of booting a second server", async () => {
    // The Studio /api/train child path: `arkor dev --local` already runs a
    // server and injected the hand-off into this process's env.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), ENV_ECHO_MANIFEST);
    process.env.ARKOR_LOCAL_SERVER_URL = "http://127.0.0.1:50505";
    process.env.ARKOR_LOCAL_SERVER_TOKEN = "parent-token-0123456789abcdef";

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await runStart({ cwd, local: true });
    } finally {
      logSpy.mockRestore();
    }

    expect(loadLocalRuntime).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("url=http://127.0.0.1:50505");
    // The parent's hand-off survives for the parent's later children.
    expect(process.env.ARKOR_LOCAL_SERVER_URL).toBe("http://127.0.0.1:50505");
  });

  it("does not touch the local runtime without --local", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
    await runStart({ cwd });
    expect(loadLocalRuntime).not.toHaveBeenCalled();
  });
});
