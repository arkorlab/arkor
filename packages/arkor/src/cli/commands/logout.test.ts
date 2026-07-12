import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  credentialsPath,
  writeCredentials,
  type AnonymousCredentials,
  type Auth0Credentials,
} from "../../core/credentials";

import { runLogout } from "./logout";

// Module-scoped clack mock so the abort-by-prompt branch is reachable
// without spinning up a real TUI.
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for("clack:cancel")),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spinner: vi.fn(),
}));

let fakeHome: string;
const ORIG_HOME = process.env.HOME;
// Node's `os.homedir()` reads HOME on POSIX but USERPROFILE (with a
// HOMEDRIVE+HOMEPATH fallback) on Windows, so HOME alone doesn't keep
// credential file IO inside the temp dir on Windows.
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOMEDRIVE = process.env.HOMEDRIVE;
const ORIG_HOMEPATH = process.env.HOMEPATH;
const ORIG_CI = process.env.CI;
// `arkor logout` itself doesn't read CLAUDECODE (since `isInteractive()`
// was reverted to its pre-PR shape), but vitest workers spawned from a
// Claude Code session inherit `CLAUDECODE=1`. Strip it in beforeEach
// (and restore from ORIG_CLAUDECODE in afterEach) so any future
// strict-mode wiring added to logout doesn't surprise these tests, and
// so the test environment matches what CI runners see.
const ORIG_CLAUDECODE = process.env.CLAUDECODE;
// Capture the original `process.stdout.isTTY` so the interactive test
// below can flip it without leaking into other test files when vitest
// reuses a worker process.
const ORIG_TTY = process.stdout.isTTY;

const anonCreds: AnonymousCredentials = {
  mode: "anon",
  token: "tok",
  anonymousId: "abc",
  arkorCloudApiUrl: "http://mock",
  orgSlug: "anon-abc",
};

const oauthCreds: Auth0Credentials = {
  mode: "auth0",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1_735_000_000,
  auth0Domain: "tenant.auth0.com",
  audience: "https://api.arkor.ai",
  clientId: "client-id",
  arkorCloudApiUrl: "https://api.arkor.ai",
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeHome = mkdtempSync(join(tmpdir(), "arkor-logout-test-"));
  process.env.HOME = fakeHome;
  // Mirror HOME into the Windows home-dir env vars so `os.homedir()`
  // points at the temp dir on every platform.
  process.env.USERPROFILE = fakeHome;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = fakeHome;
  // promptConfirm honours skipWith first, but in non-skip paths it falls
  // through to initialValue when CI=1. Pin CI so the prompt never opens.
  process.env.CI = "1";
  delete process.env.CLAUDECODE;
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined)
    process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIG_HOMEDRIVE !== undefined) process.env.HOMEDRIVE = ORIG_HOMEDRIVE;
  else delete process.env.HOMEDRIVE;
  if (ORIG_HOMEPATH !== undefined) process.env.HOMEPATH = ORIG_HOMEPATH;
  else delete process.env.HOMEPATH;
  if (ORIG_CI !== undefined) process.env.CI = ORIG_CI;
  else delete process.env.CI;
  if (ORIG_CLAUDECODE !== undefined) process.env.CLAUDECODE = ORIG_CLAUDECODE;
  else delete process.env.CLAUDECODE;
  // Restore the TTY flag in case the interactive test mutated it;
  // otherwise a later test that unsets CI would unexpectedly enter
  // interactive prompt paths.
  Object.defineProperty(process.stdout, "isTTY", {
    value: ORIG_TTY,
    configurable: true,
  });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("runLogout", () => {
  it("is a no-op when no credentials file exists", async () => {
    expect(existsSync(credentialsPath())).toBe(false);
    await expect(runLogout()).resolves.toBeUndefined();
  });

  it("removes the credentials file when --force is passed", async () => {
    await writeCredentials(anonCreds);
    expect(existsSync(credentialsPath())).toBe(true);

    await runLogout({ force: true });
    expect(existsSync(credentialsPath())).toBe(false);

    const clack = await import("@clack/prompts");
    expect(clack.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be restored/i),
    );
  });

  it("keeps the credentials file in non-interactive mode without --force", async () => {
    // Without `force`, the helper falls back to promptConfirm which honours
    // initialValue=false under CI. The behaviour mirrors the user pressing
    // Enter at the default prompt.
    await writeCredentials(anonCreds);
    await runLogout();
    expect(existsSync(credentialsPath())).toBe(true);

    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  it("defaults the interactive confirmation to no and aborts when the user declines", async () => {
    // Pretend we're in a TTY so promptConfirm enters the clack branch
    // instead of returning the initialValue. This exercises the
    // `if (!confirmed)` early-return that's otherwise unreachable.
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");
    vi.mocked(clack.confirm).mockResolvedValueOnce(false as never);

    await writeCredentials(anonCreds);
    await runLogout();
    expect(existsSync(credentialsPath())).toBe(true);
    expect(clack.log.warn).not.toHaveBeenCalled();
    expect(clack.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining(`Delete ${credentialsPath()}?`),
      initialValue: false,
    });
    expect(clack.confirm).toHaveBeenCalledWith({
      message: expect.stringMatching(/cannot be restored/i),
      initialValue: false,
    });
  });

  it("removes the credentials file when the user confirms interactively", async () => {
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const clack = await import("@clack/prompts");
    vi.mocked(clack.confirm).mockResolvedValueOnce(true as never);

    await writeCredentials(anonCreds);
    await runLogout();
    expect(existsSync(credentialsPath())).toBe(false);
    expect(clack.log.warn).not.toHaveBeenCalled();
    expect(clack.confirm).toHaveBeenCalledWith({
      message: expect.stringMatching(/cannot be restored/i),
      initialValue: false,
    });
  });

  it("does not print the anonymous restore warning for OAuth credentials", async () => {
    await writeCredentials(oauthCreds);

    await runLogout({ force: true });
    expect(existsSync(credentialsPath())).toBe(false);

    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  it("keeps OAuth credentials in non-interactive mode without --force", async () => {
    await writeCredentials(oauthCreds);

    await runLogout();
    expect(existsSync(credentialsPath())).toBe(true);

    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });
});
