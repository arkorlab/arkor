import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli } from "./spawn-cli";

/**
 * E2E for `arkor start --local`.
 *
 * The full-run scenario is gated to Apple Silicon macOS because the MLX
 * backend's preflight (platform + arch) runs for real; there is no test
 * back door in production code. It executes on CI's macos (arm64) matrix
 * leg and skips elsewhere. `uv` itself is faked: a stub on PATH that execs
 * a Node "trainer" speaking the shim protocol, so the scenario covers
 * everything except Python/mlx-lm (which the scheduled real-training smoke
 * workflow covers on real hardware).
 *
 * The not-installed scenario runs on every OS: it never reaches preflight.
 */

const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";

const ARKOR_PKG_DIR = fileURLToPath(
  new URL("../../../packages/arkor", import.meta.url),
);
const ARKOR_LOCAL_PKG_DIR = fileURLToPath(
  new URL("../../../packages/arkor-local", import.meta.url),
);

let cwd: string;

beforeEach(() => {
  cwd = makeTempDir("arkor-start-local-e2e-");
});

afterEach(() => {
  cleanup(cwd);
});

/** Trainer manifest using the real SDK from the linked workspace package. */
const LOCAL_MANIFEST = `import { createArkor, createTrainer } from "arkor";

export const arkor = createArkor({
  trainer: createTrainer({
    name: "local-e2e-run",
    model: "mlx-community/e2e-tiny-model",
    dataset: { type: "huggingface", name: "org/data" },
    datasetFormat: { type: "chatml" },
    maxSteps: 3,
    callbacks: {
      onLog: ({ step, loss }) => {
        console.log("[cb] log step=" + step + " loss=" + loss);
      },
      onCompleted: () => {
        console.log("[cb] completed");
      },
    },
  }),
});
`;

/**
 * Node script standing in for the Python training shim: reads run.json,
 * writes a normalised adapter dir, and emits protocol lines.
 */
const FAKE_TRAINER = String.raw`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const runPath = process.argv[process.argv.indexOf("--run") + 1];
const run = JSON.parse(readFileSync(runPath, "utf8"));
const adaptersDir = run.paths.adaptersDir;
const finalDir = join(adaptersDir, "final");
mkdirSync(finalDir, { recursive: true });
writeFileSync(join(finalDir, "adapter_config.json"), "{}\n");
writeFileSync(join(finalDir, "adapters.safetensors"), "fake-weights\n");
const emit = (o) => process.stdout.write("@arkor " + JSON.stringify(o) + "\n");
emit({ type: "started" });
emit({ type: "log", step: 1, loss: 2.5, learningRate: 0.00001 });
emit({ type: "log", step: 3, loss: 1.5, learningRate: 0.00001 });
emit({ type: "completed", adapterDir: finalDir });
`;

/**
 * Install a fake `uv` on PATH: a POSIX shell stub that ignores the
 * `run --with ...` machinery and execs the fake trainer with the
 * `--run <run.json>` argument it finds. `--version` support keeps the
 * preflight probe green.
 */
function installFakeUv(dir: string): string {
  const binDir = join(dir, "fake-uv-bin");
  mkdirSync(binDir, { recursive: true });
  const trainerPath = join(binDir, "fake-trainer.mjs");
  writeFileSync(trainerPath, FAKE_TRAINER);
  const uvPath = join(binDir, "uv");
  writeFileSync(
    uvPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "uv 9.9.9 (fake)"
  exit 0
fi
RUN=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--run" ]; then RUN="$a"; fi
  prev="$a"
done
exec "${process.execPath}" "${trainerPath}" --run "$RUN"
`,
  );
  chmodSync(uvPath, 0o755);
  return binDir;
}

/**
 * Make the built workspace packages resolvable from the temp project
 * without a package-manager install: symlink them into node_modules the
 * way a node-linker=node-modules install would lay them out.
 */
function linkWorkspacePackages(dir: string): void {
  mkdirSync(join(dir, "node_modules", "@arkor"), { recursive: true });
  symlinkSync(ARKOR_PKG_DIR, join(dir, "node_modules", "arkor"), "junction");
  symlinkSync(
    ARKOR_LOCAL_PKG_DIR,
    join(dir, "node_modules", "@arkor", "local"),
    "junction",
  );
}

function seedProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "local-e2e", type: "module" }),
  );
  mkdirSync(join(dir, "src", "arkor"), { recursive: true });
  writeFileSync(join(dir, "src", "arkor", "index.ts"), LOCAL_MANIFEST);
}

describe.skipIf(!APPLE_SILICON)("arkor start --local (E2E, fake uv)", () => {
  it("trains end to end through the local server and records events + adapters", async () => {
    seedProject(cwd);
    linkWorkspacePackages(cwd);
    const fakeUvDir = installFakeUv(cwd);

    const result = await runCli(ARKOR_BIN, ["start", "--local"], cwd, {
      PATH: `${fakeUvDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).not.toMatch(/Error|error:/);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Local training via MLX (Apple Silicon)");
    expect(result.stdout).toContain("Started job ");
    expect(result.stdout).toContain("finished with status=completed");
    // SDK callbacks observed the SSE events from the local server.
    expect(result.stdout).toContain("[cb] log step=1 loss=2.5");
    expect(result.stdout).toContain("[cb] log step=3 loss=1.5");
    expect(result.stdout).toContain("[cb] completed");

    // Durable job store: one job dir with the full event history.
    const jobsDir = join(cwd, ".arkor", "local", "jobs");
    const jobDirs = readdirSync(jobsDir);
    expect(jobDirs).toHaveLength(1);
    const jobDir = join(jobsDir, jobDirs[0] as string);
    const events = readFileSync(join(jobDir, "events.jsonl"), "utf8");
    expect(events).toContain('"training.started"');
    expect(events).toContain('"training.log"');
    expect(events).toContain('"training.completed"');
    // The fake trainer's normalised adapter output survived.
    expect(
      existsSync(join(jobDir, "adapters", "final", "adapters.safetensors")),
    ).toBe(true);
    expect(
      existsSync(join(jobDir, "adapters", "final", "adapter_config.json")),
    ).toBe(true);
  }, 60_000);

  it("surfaces backend config rejections as a clear failure", async () => {
    // maxSteps/numTrainEpochs missing: the MLX backend rejects at POST
    // /v1/jobs and the SDK surfaces the 400 before any child spawns.
    seedProject(cwd);
    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      LOCAL_MANIFEST.replace("maxSteps: 3,\n", ""),
    );
    linkWorkspacePackages(cwd);
    const fakeUvDir = installFakeUv(cwd);

    const result = await runCli(ARKOR_BIN, ["start", "--local"], cwd, {
      PATH: `${fakeUvDir}:${process.env.PATH ?? ""}`,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("maxSteps or numTrainEpochs");
  }, 60_000);
});

describe("arkor start --local without @arkor/local (E2E)", () => {
  it("fails with the install hint and no stack noise", async () => {
    seedProject(cwd);
    // No node_modules at all: resolution must fail in the loader.
    const result = await runCli(ARKOR_BIN, ["start", "--local"], cwd);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("@arkor/local");
    expect(result.stderr).toContain("pnpm add -D @arkor/local");
    // bin.ts prints the actionable message only, not a minified stack.
    expect(result.stderr).not.toContain("at ");
  });
});
