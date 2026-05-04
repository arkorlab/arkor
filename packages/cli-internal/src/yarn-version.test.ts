import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// `vi.hoisted` ensures the spawn mock is in place before the
// module under test resolves its `node:child_process` import.
// Same pattern as `e2e/cli/src/spawn-cli.test.ts`.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// eslint-disable-next-line import/first
import { detectYarnMajor } from "./yarn-version";

interface FakeChildOptions {
  /** stdout chunks emitted before close. */
  stdout?: string[];
  /** Close-event tuple. Pass `[null, "SIGKILL"]` for signal kills. */
  close?: [number | null, NodeJS.Signals | null];
  /** When set, emit `error` instead of `close`. */
  error?: Error;
}

function makeFakeChild(opts: FakeChildOptions): EventEmitter {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, {
    stdout,
    stderr,
    kill: vi.fn(),
  });
  setImmediate(() => {
    for (const chunk of opts.stdout ?? []) {
      stdout.emit("data", Buffer.from(chunk, "utf8"));
    }
    if (opts.error) {
      child.emit("error", opts.error);
    } else {
      const [code, signal] = opts.close ?? [0, null];
      child.emit("close", code, signal);
    }
  });
  return child;
}

describe("detectYarnMajor", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses the major from a yarn 1 version output", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["1.22.22\n"], close: [0, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBe(1);
  });

  it("parses the major from a yarn 4 version output", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["4.6.0\n"], close: [0, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBe(4);
  });

  it("invokes `yarn --version` with cwd-relative resolution", async () => {
    // Cwd-relative resolution is what makes corepack's
    // `packageManager:`-aware lookup work (a workspace-pinned
    // yarn wins over the global PATH). The contract we lock
    // down: spawn is called with the cwd we passed.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["4.6.0\n"], close: [0, null] }),
    );

    await detectYarnMajor("/some/project");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("yarn");
    expect(argv).toEqual(["--version"]);
    expect((opts as { cwd: string }).cwd).toBe("/some/project");
  });

  it("uses `shell: true` only on win32", async () => {
    // yarn is a `.cmd` shim on Windows; Node refuses to execute
    // `.cmd`/`.bat` through `spawn` without a shell. Mirror
    // `cli-internal/install.ts`'s policy and lock it down here
    // so a refactor that drops the platform check trips this
    // test rather than failing the install-matrix.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["4.6.0\n"], close: [0, null] }),
    );

    await detectYarnMajor("/cwd");

    const opts = spawnMock.mock.calls[0]![2] as { shell: boolean };
    expect(opts.shell).toBe(process.platform === "win32");
  });

  it("returns undefined when the spawn `error` event fires (yarn not on PATH)", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ error: new Error("ENOENT spawn yarn") }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBeUndefined();
  });

  it("returns undefined when yarn exits non-zero", async () => {
    // e.g. corepack rejecting the project's `packageManager` field
    // and exiting before `yarn --version` runs.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: [], close: [1, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBeUndefined();
  });

  it("returns undefined for malformed version output", async () => {
    // A future yarn that drops the leading digit, or a corepack
    // shim that prints a banner before the version, etc. Be
    // conservative: if we can't parse, don't claim to know.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["banana\n"], close: [0, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBeUndefined();
  });

  it("returns undefined for an empty version output", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: [""], close: [0, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBeUndefined();
  });

  it("returns undefined when the subprocess hangs past the 5s timeout", async () => {
    vi.useFakeTimers();
    // Hung child: emits no stdout and never fires close. The
    // timeout in detectYarnMajor should kill it and resolve
    // with undefined.
    let killed = false;
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => {
          killed = true;
        }),
      });
      // Never emit close or error.
      return child;
    });

    const promise = detectYarnMajor("/fake/cwd");
    // Advance past the 5s timeout the helper installs.
    await vi.advanceTimersByTimeAsync(5_000);

    const major = await promise;

    expect(major).toBeUndefined();
    expect(killed).toBe(true);
  });

  it("rejects multi-digit majors correctly (e.g. 10.x → 10)", async () => {
    // Forward compatibility: `^(\d+)\.` is a greedy digit run, so
    // a hypothetical yarn 10 should parse to 10, not 1. Locked
    // down so a future regex tightening (e.g. accidental
    // single-digit cap) trips this test.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ stdout: ["10.0.0\n"], close: [0, null] }),
    );

    const major = await detectYarnMajor("/fake/cwd");

    expect(major).toBe(10);
  });
});
