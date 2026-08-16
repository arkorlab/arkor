#!/usr/bin/env node
/**
 * Real-hardware smoke test for local MLX training, run by
 * `.github/workflows/local-training-smoke.yaml` on an Apple Silicon macOS
 * runner for every push and pull request (plus nightly and on manual
 * dispatch), and runnable by hand on any Apple Silicon Mac with uv
 * installed:
 *
 *   node scripts/local-training-smoke.mjs
 *
 * Unlike the unit / e2e suites (which fake uv), this drives the REAL stack:
 * uv resolves the pinned mlx-lm, the Python shim prepares a blob dataset,
 * trains a tiny model for a handful of steps, the SDK streams events from
 * the local server, `onCheckpoint.infer()` chats against the trained
 * adapter through `mlx_lm server`, and the script asserts on all of it.
 *
 * The dataset is served from an in-process loopback HTTP server (a blob
 * source) so the run needs the network only for the model download, which
 * the workflow caches.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARKOR_BIN = join(repoRoot, "packages/arkor/dist/bin.mjs");
const ARKOR_PKG = join(repoRoot, "packages/arkor");
const ARKOR_LOCAL_PKG = join(repoRoot, "packages/arkor-local");

const MODEL = "mlx-community/SmolLM2-135M-Instruct";
const TIMEOUT_MS = 20 * 60_000;

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(ARKOR_BIN)) {
  fail(`missing ${ARKOR_BIN}; run \`pnpm build\` first`);
}
if (!existsSync(join(ARKOR_LOCAL_PKG, "dist/index.mjs"))) {
  fail(`missing @arkor/local build; run \`pnpm build\` first`);
}

// ---- blob dataset server ---------------------------------------------------

const ROWS = Array.from({ length: 24 }, (_, i) =>
  JSON.stringify({
    messages: [
      { role: "user", content: `Say the number ${i} in words.` },
      { role: "assistant", content: `Number ${i}.` },
    ],
  }),
).join("\n");

const blobServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/jsonl" });
  res.end(ROWS);
});
await new Promise((resolve) => blobServer.listen(0, "127.0.0.1", resolve));
const blobUrl = `http://127.0.0.1:${blobServer.address().port}/train.jsonl`;
console.log(`[smoke] blob dataset at ${blobUrl}`);

// ---- temp project ----------------------------------------------------------

const projectDir = mkdtempSync(join(tmpdir(), "arkor-smoke-"));
const markerPath = join(projectDir, "smoke-marker.jsonl");
console.log(`[smoke] project at ${projectDir}`);

writeFileSync(
  join(projectDir, "package.json"),
  JSON.stringify({ name: "arkor-smoke", version: "0.0.0", type: "module" }),
);
mkdirSync(join(projectDir, "node_modules", "@arkor"), { recursive: true });
symlinkSync(ARKOR_PKG, join(projectDir, "node_modules", "arkor"), "junction");
symlinkSync(
  ARKOR_LOCAL_PKG,
  join(projectDir, "node_modules", "@arkor", "local"),
  "junction",
);

mkdirSync(join(projectDir, "src", "arkor"), { recursive: true });
writeFileSync(
  join(projectDir, "src", "arkor", "index.ts"),
  `import { appendFileSync } from "node:fs";
import { createArkor, createTrainer } from "arkor";

const marker = (entry: Record<string, unknown>) => {
  appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(entry) + "\\n");
};

export const arkor = createArkor({
  trainer: createTrainer({
    name: "mlx-smoke-run",
    model: ${JSON.stringify(MODEL)},
    dataset: { type: "blob", url: ${JSON.stringify(blobUrl)} },
    datasetFormat: { type: "chatml" },
    maxSteps: 4,
    batchSize: 1,
    loggingSteps: 1,
    saveSteps: 2,
    lora: { r: 8, alpha: 16, maxLength: 512 },
    callbacks: {
      onLog: ({ step, loss }) => {
        marker({ kind: "log", step, loss });
      },
      onCheckpoint: async (ctx) => {
        const res = await ctx.infer({
          messages: [{ role: "user", content: "Say hello." }],
          maxTokens: 16,
          stream: false,
        });
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        marker({
          kind: "infer",
          step: ctx.step,
          status: res.status,
          content: body.choices?.[0]?.message?.content ?? null,
        });
      },
      onCompleted: ({ artifacts }) => {
        marker({ kind: "completed", artifacts });
      },
    },
  }),
});
`,
);

// ---- run -------------------------------------------------------------------

console.log(`[smoke] running: node ${ARKOR_BIN} start --local`);
const child = spawn(process.execPath, [ARKOR_BIN, "start", "--local"], {
  cwd: projectDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ARKOR_TELEMETRY_DISABLED: "1", CI: "1" },
});
let stdout = "";
child.stdout.on("data", (d) => {
  stdout += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => process.stderr.write(d));

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    console.error(`[smoke] timed out after ${TIMEOUT_MS}ms`);
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  child.on("close", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
blobServer.close();

// ---- assertions ------------------------------------------------------------

if (code !== 0) fail(`arkor start --local exited with code ${code}`);
if (!stdout.includes("finished with status=completed")) {
  fail("stdout does not report a completed job");
}

const markers = readFileSync(markerPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const logs = markers.filter((m) => m.kind === "log");
if (logs.length === 0) fail("no training.log events reached the SDK callback");
if (!logs.some((m) => Number.isFinite(m.loss))) {
  fail(`no finite loss in log events: ${JSON.stringify(logs)}`);
}
const infers = markers.filter((m) => m.kind === "infer");
if (infers.length === 0) fail("onCheckpoint.infer never ran");
if (!infers.some((m) => m.status === 200 && m.content)) {
  fail(`local inference produced no content: ${JSON.stringify(infers)}`);
}
if (!markers.some((m) => m.kind === "completed")) {
  fail("onCompleted never ran");
}

const jobsDir = join(projectDir, ".arkor", "local", "jobs");
const jobDirs = readdirSync(jobsDir);
if (jobDirs.length !== 1) fail(`expected 1 job dir, got ${jobDirs.length}`);
const jobDir = join(jobsDir, jobDirs[0]);
const events = readFileSync(join(jobDir, "events.jsonl"), "utf8");
for (const type of [
  "training.started",
  "training.log",
  "checkpoint.saved",
  "training.completed",
]) {
  if (!events.includes(`"${type}"`)) fail(`events.jsonl is missing ${type}`);
}
const finalDir = join(jobDir, "adapters", "final");
for (const file of ["adapters.safetensors", "adapter_config.json"]) {
  if (!existsSync(join(finalDir, file))) {
    fail(`missing ${file} in ${finalDir}`);
  }
}

console.log(
  "[smoke] PASS: training, events, adapters, and inference all verified",
);
rmSync(projectDir, { recursive: true, force: true });
