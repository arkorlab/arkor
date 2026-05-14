import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock every command handler so main() exercises only the Commander
// wiring + the post-parse epilog (deprecation flush + telemetry
// shutdown). Each handler captures its opts so we can assert on the
// shape main() forwarded.
vi.mock("./commands/init", () => ({ runInit: vi.fn() }));
vi.mock("./commands/login", () => ({ runLogin: vi.fn() }));
vi.mock("./commands/logout", () => ({ runLogout: vi.fn() }));
vi.mock("./commands/whoami", () => ({ runWhoami: vi.fn() }));
vi.mock("./commands/build", () => ({ runBuild: vi.fn() }));
vi.mock("./commands/start", () => ({ runStart: vi.fn() }));
vi.mock("./commands/dev", () => ({ runDev: vi.fn() }));

// Telemetry: the wrapper just delegates to the inner handler in tests
// so we don't have to thread PostHog state through every assertion.
vi.mock("../core/telemetry", () => ({
  withTelemetry:
    <TArgs extends unknown[]>(
      _name: string,
      handler: (...args: TArgs) => Promise<void>,
    ) =>
    async (...args: TArgs) => handler(...args),
  shutdownTelemetry: vi.fn(async () => undefined),
}));

// Deprecation latch is module-state; we read it from a controllable mock
// so we can assert main()'s end-of-run flush printed.
const mockDeprecation = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../core/deprecation", () => ({
  recordDeprecation: vi.fn(),
  getRecordedDeprecation: vi.fn(() => mockDeprecation.value),
  tapDeprecation: vi.fn(),
}));

import { runBuild } from "./commands/build";
import { runDev } from "./commands/dev";
import { runInit } from "./commands/init";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runStart } from "./commands/start";
import { runWhoami } from "./commands/whoami";
import { shutdownTelemetry } from "../core/telemetry";
import { main } from "./main";

// Capture once so the after-each can restore — without this, tests that
// set `npm_config_user_agent` to drive package-manager detection leak the
// override into later test files when vitest reuses a worker process.
const ORIG_USER_AGENT = process.env.npm_config_user_agent;

beforeEach(() => {
  vi.mocked(runInit).mockReset();
  vi.mocked(runLogin).mockReset();
  vi.mocked(runLogout).mockReset();
  vi.mocked(runWhoami).mockReset();
  vi.mocked(runBuild).mockReset();
  vi.mocked(runStart).mockReset();
  vi.mocked(runDev).mockReset();
  vi.mocked(shutdownTelemetry).mockReset();
  vi.mocked(shutdownTelemetry).mockResolvedValue(undefined);
  mockDeprecation.value = null;
});

afterEach(() => {
  if (ORIG_USER_AGENT !== undefined) {
    process.env.npm_config_user_agent = ORIG_USER_AGENT;
  } else {
    delete process.env.npm_config_user_agent;
  }
  vi.restoreAllMocks();
});

describe("main (CLI Commander wiring)", () => {
  it("dispatches `init` with parsed flags + resolved package manager", async () => {
    // afterEach restores `npm_config_user_agent`, so per-test cleanup
    // isn't needed here.
    process.env.npm_config_user_agent = "pnpm/10 node/v22 linux x64";
    await main([
      "init",
      "--yes",
      "--name",
      "my-app",
      "--template",
      "triage",
      "--skip-install",
    ]);
    expect(runInit).toHaveBeenCalledWith({
      yes: true,
      name: "my-app",
      template: "triage",
      skipInstall: true,
      packageManager: "pnpm",
      git: undefined,
      skipGit: undefined,
      // No --agents-md / --no-agents-md passed → main.ts resolves the
      // CLI default-on (`opts.agentsMd !== false`).
      agentsMd: true,
    });
  });

  it("forwards --use-* flags to the package-manager resolver", async () => {
    delete process.env.npm_config_user_agent;
    await main(["init", "--use-bun", "--yes"]);
    expect(runInit).toHaveBeenCalledWith(
      expect.objectContaining({ packageManager: "bun" }),
    );
  });

  it("rejects `init --git --skip-git` (mutually exclusive)", async () => {
    await expect(
      main(["init", "--git", "--skip-git"]),
    ).rejects.toThrow(/--git \/ --skip-git, not both/);
    expect(runInit).not.toHaveBeenCalled();
  });

  it("rejects `init --agents-md --no-agents-md` from main()'s argv (not process.argv)", async () => {
    // The check must read the argv array passed to main(), not the
    // surrounding process.argv. Using process.argv would (a) miss the
    // conflict here because vitest's process.argv contains neither flag,
    // and (b) false-positive in environments where the parent process
    // happens to carry those tokens.
    await expect(
      main(["init", "--agents-md", "--no-agents-md"]),
    ).rejects.toThrow(/--agents-md \/ --no-agents-md, not both/);
    expect(runInit).not.toHaveBeenCalled();
  });


  it("dispatches `login` with parsed --oauth / --no-browser flags", async () => {
    await main(["login", "--oauth", "--no-browser"]);
    expect(runLogin).toHaveBeenCalledWith({
      oauth: true,
      anonymous: undefined,
      noBrowser: true,
    });
  });

  it("dispatches `login --anonymous` and translates Commander's --no-browser default", async () => {
    await main(["login", "--anonymous"]);
    expect(runLogin).toHaveBeenCalledWith({
      oauth: undefined,
      anonymous: true,
      noBrowser: false,
    });
  });

  it("rejects `login --oauth --anonymous` at the CLI layer", async () => {
    await expect(
      main(["login", "--oauth", "--anonymous"]),
    ).rejects.toThrow(/--oauth \/ --anonymous, not both/);
    expect(runLogin).not.toHaveBeenCalled();
  });

  it("dispatches `logout --yes`", async () => {
    await main(["logout", "--yes"]);
    expect(runLogout).toHaveBeenCalledWith({ yes: true });
  });

  it("dispatches `whoami`", async () => {
    await main(["whoami"]);
    expect(runWhoami).toHaveBeenCalledOnce();
  });

  it("dispatches `build` with an explicit entry argument", async () => {
    await main(["build", "src/custom-entry.ts"]);
    expect(runBuild).toHaveBeenCalledWith({ entry: "src/custom-entry.ts" });
  });

  it("dispatches `build` with no entry (Commander passes undefined)", async () => {
    await main(["build"]);
    expect(runBuild).toHaveBeenCalledWith({ entry: undefined });
  });

  it("dispatches `start` with optional entry", async () => {
    await main(["start", "alt.ts"]);
    expect(runStart).toHaveBeenCalledWith({ entry: "alt.ts" });
  });

  it("dispatches `dev` with the parsed port + --open flag", async () => {
    await main(["dev", "--port", "4500", "--open"]);
    expect(runDev).toHaveBeenCalledWith({ port: 4500, open: true });
  });

  it("falls back to port 4000 when --port is non-numeric", async () => {
    // Branch coverage for the `Number(opts.port) || 4000` defaulting.
    await main(["dev", "--port", "not-a-number"]);
    expect(runDev).toHaveBeenCalledWith({ port: 4000, open: false });
  });

  it("flushes a recorded deprecation warning after parse and awaits shutdownTelemetry", async () => {
    mockDeprecation.value = {
      sdkVersion: "1.4.0",
      message: "Arkor SDK 1.4.0 is deprecated",
      sunset: "Wed, 01 Jul 2026 00:00:00 GMT",
    };
    // clack's `ui.log.warn` writes the formatted line to stdout.
    const stdoutChunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: unknown) => {
        stdoutChunks.push(String(c));
        return true;
      }) as typeof process.stdout.write);
    try {
      await main(["whoami"]);
    } finally {
      spy.mockRestore();
    }
    expect(shutdownTelemetry).toHaveBeenCalledOnce();
    const buf = stdoutChunks.join("");
    expect(buf).toMatch(/Arkor SDK 1\.4\.0 is deprecated/);
    expect(buf).toMatch(/Cutoff: Wed, 01 Jul 2026 00:00:00 GMT/);
  });

  it("still calls shutdownTelemetry when a command throws (finally block)", async () => {
    vi.mocked(runWhoami).mockRejectedValueOnce(new Error("boom"));
    await expect(main(["whoami"])).rejects.toThrow(/boom/);
    expect(shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it("under CLAUDECODE=1 + missing flags, throws ClaudeCodeStrictExit so the finally block still runs (shutdownTelemetry fires, no project name skip)", async () => {
    // ENG-736 PR review (#141): the validator used to `process.exit(1)`
    // inside the action handler, which bypassed main()'s finally and
    // lost telemetry / deprecation flushing. The validator now throws
    // a sentinel so the finally still runs; bin.ts is the layer that
    // recognises the sentinel and sets exitCode without re-printing.
    process.env.CLAUDECODE = "1";
    const stderrChunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((c: unknown) => {
        stderrChunks.push(String(c));
        return true;
      }) as typeof process.stderr.write);
    try {
      await expect(
        main(["init", "--template", "triage", "--skip-git"]),
        // Missing: pm flag + agents-md flag.
      ).rejects.toMatchObject({ name: "ClaudeCodeStrictExit" });
    } finally {
      spy.mockRestore();
      delete process.env.CLAUDECODE;
    }
    expect(shutdownTelemetry).toHaveBeenCalledOnce();
    const buf = stderrChunks.join("");
    expect(buf).toContain("arkor init: CLAUDECODE=1 detected");
    expect(buf).toContain("--use-pnpm");
    expect(buf).toContain("--agents-md (recommended) or --no-agents-md");
    expect(runInit).not.toHaveBeenCalled();
  });

  it("under CLAUDECODE=1 with every flag set (no --yes), passes the strict check and delegates to runInit", async () => {
    // The happy-path mirror of the test above: a fully-specified
    // invocation still runs to completion under CLAUDECODE, since the
    // validator is gated on missing flags only.
    process.env.CLAUDECODE = "1";
    try {
      await main([
        "init",
        "--name",
        "my-app",
        "--template",
        "triage",
        "--skip-git",
        "--skip-install",
        "--no-agents-md",
      ]);
    } finally {
      delete process.env.CLAUDECODE;
    }
    expect(runInit).toHaveBeenCalledOnce();
  });

  it("omits the Cutoff suffix when the deprecation has no sunset value", async () => {
    // Branch coverage for the `notice.sunset ? ` Cutoff: …` : ""` ternary.
    mockDeprecation.value = {
      sdkVersion: "1.4.0",
      message: "Arkor SDK 1.4.0 is deprecated",
      sunset: null,
    };
    // clack's `ui.log.warn` writes the formatted line to stdout.
    const stdoutChunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: unknown) => {
        stdoutChunks.push(String(c));
        return true;
      }) as typeof process.stdout.write);
    try {
      await main(["whoami"]);
    } finally {
      spy.mockRestore();
    }
    const buf = stdoutChunks.join("");
    expect(buf).toMatch(/Arkor SDK 1\.4\.0 is deprecated/);
    expect(buf).not.toMatch(/Cutoff:/);
  });
});
