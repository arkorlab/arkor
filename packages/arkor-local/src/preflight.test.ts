import { describe, expect, it } from "vitest";

import {
  BackendSelectionError,
  defaultExecProbe,
  probeUv,
  selectBackend,
} from "./preflight";

import type {
  ExecProbe,
  LocalTrainingBackend,
  PreflightEnv,
  PreflightResult,
} from "./backends/types";

function fakeBackend(
  id: string,
  result: PreflightResult,
): LocalTrainingBackend {
  return {
    id,
    displayName: `${id} backend`,
    preflight: () => Promise.resolve(result),
    validateConfig: () => ({ ok: true }),
    buildTrainRun: () => {
      throw new Error("not under test");
    },
  };
}

function env(probe: ExecProbe): PreflightEnv {
  return { platform: "darwin", arch: "arm64", execProbe: probe };
}

const okProbe: ExecProbe = () => Promise.resolve({ ok: true, stdout: "uv" });

describe("probeUv", () => {
  it("passes when uv responds", async () => {
    await expect(probeUv(okProbe)).resolves.toEqual({ ok: true });
  });

  it("fails with the install hint when uv is missing", async () => {
    const result = await probeUv(() =>
      Promise.resolve({ ok: false, stdout: "", error: "spawn uv ENOENT" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("spawn uv ENOENT");
      expect(result.remediation).toContain("does not install uv for you");
    }
  });
});

describe("defaultExecProbe", () => {
  it("captures stdout from a successful command", async () => {
    const result = await defaultExecProbe(
      process.execPath,
      ["-e", "console.log('probe-ok')"],
      10_000,
    );
    expect(result).toEqual({ ok: true, stdout: "probe-ok" });
  });

  it("reports a non-zero exit with stderr context", async () => {
    const result = await defaultExecProbe(
      process.execPath,
      ["-e", "console.error('bad'); process.exit(3)"],
      10_000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("code 3");
    expect(result.error).toContain("bad");
  });

  it("reports a missing binary instead of throwing", async () => {
    const result = await defaultExecProbe(
      "definitely-not-a-real-binary-arkor",
      ["--version"],
      10_000,
    );
    expect(result.ok).toBe(false);
  });

  it("times out a hanging command", async () => {
    const result = await defaultExecProbe(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      250,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("selectBackend", () => {
  it("returns the first backend whose preflight passes", async () => {
    const first = fakeBackend("first", {
      ok: false,
      reason: "not supported here",
    });
    const second = fakeBackend("second", { ok: true });
    const third = fakeBackend("third", { ok: true });
    await expect(
      selectBackend({ backends: [first, second, third], env: env(okProbe) }),
    ).resolves.toBe(second);
  });

  it("aggregates every backend's reason when none passes", async () => {
    const a = fakeBackend("mlx", {
      ok: false,
      reason: "requires an Apple Silicon Mac",
    });
    const b = fakeBackend("cuda", {
      ok: false,
      reason: "nvidia-smi not found",
      remediation: "Install the NVIDIA driver.",
    });
    const promise = selectBackend({ backends: [a, b], env: env(okProbe) });
    await expect(promise).rejects.toBeInstanceOf(BackendSelectionError);
    await expect(promise).rejects.toThrow(/mlx.*Apple Silicon/s);
    await expect(promise).rejects.toThrow(/cuda.*nvidia-smi/s);
    await expect(promise).rejects.toThrow(/Install the NVIDIA driver/);
  });

  it("honours requestedId and still runs its preflight", async () => {
    const good = fakeBackend("good", { ok: true });
    const bad = fakeBackend("bad", { ok: false, reason: "nope" });
    await expect(
      selectBackend({
        backends: [good, bad],
        env: env(okProbe),
        requestedId: "good",
      }),
    ).resolves.toBe(good);
    await expect(
      selectBackend({
        backends: [good, bad],
        env: env(okProbe),
        requestedId: "bad",
      }),
    ).rejects.toThrow(/requested local training backend/);
  });

  it("rejects an unknown requestedId listing the known ids", async () => {
    await expect(
      selectBackend({
        backends: [fakeBackend("mlx", { ok: true })],
        env: env(okProbe),
        requestedId: "rocm",
      }),
    ).rejects.toThrow(/Unknown local training backend "rocm".*mlx/);
  });
});
