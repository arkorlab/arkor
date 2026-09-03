/**
 * Stand-in for a backend training shim, spawned by runner tests through a
 * FakeBackend. Reads the run.json written by the RunManager and follows the
 * `fixture` block embedded in it:
 *
 *   {
 *     "fixture": {
 *       "chunks":    string[]   raw stdout writes (protocol lines carry the
 *                               "@arkor " marker themselves; a chunk may be
 *                               a partial line to exercise tearing)
 *       "chunkDelayMs": number  pause between chunks (default 0)
 *       "stderr":    string[]   lines written to stderr
 *       "exitCode":  number     final exit code (default 0)
 *       "hang":      boolean    after the chunks, stay alive until signalled
 *       "orphanChild": boolean  spawn a grandchild that INHERITS stdout and
 *                               outlives this process (mirrors `uv`
 *                               exiting while the Python trainer runs on):
 *                               'exit' fires but 'close' does not
 *       "adapterDirs": string[] directories to create with an
 *                               adapter_config.json inside (relative to the
 *                               job dir)
 *     }
 *   }
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const runFlag = process.argv.indexOf("--run");
const runPath = runFlag === -1 ? undefined : process.argv[runFlag + 1];
if (!runPath) {
  // Thrown (not process.exit) so the child dies non-zero with a stack the
  // runner captures in console.log, satisfying unicorn/no-process-exit.
  throw new Error("fake-trainer: missing --run <run.json>");
}
const run = JSON.parse(readFileSync(runPath, "utf8"));
const fixture = run.fixture ?? {};
const jobDir = dirname(runPath);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const dir of fixture.adapterDirs ?? []) {
  const abs = join(jobDir, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, "adapter_config.json"), "{}\n");
}

for (const line of fixture.stderr ?? []) {
  process.stderr.write(`${line}\n`);
}

for (const chunk of fixture.chunks ?? []) {
  process.stdout.write(chunk);
  if (fixture.chunkDelayMs) await sleep(fixture.chunkDelayMs);
}

if (fixture.orphanChild) {
  // Inherits this process's stdout, so the runner's pipe stays open (and
  // 'close' stays unfired) after this process exits. Same process group,
  // so a group signal reaches it.
  const grandchild = spawn(
    process.execPath,
    // Self-destructs after 60s: if the group signal under test regresses,
    // the test fails on its timeout and this process would otherwise keep
    // running (and holding a CI runner's Node process) forever.
    [
      "-e",
      "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)",
    ],
    { stdio: ["ignore", "inherit", "ignore"] },
  );
  // unref (but NOT detached): the handle would otherwise keep THIS
  // process's event loop alive, and detaching would move the grandchild
  // out of the process group the runner signals.
  grandchild.unref();
  // Give the spawn a moment to land before this process goes away.
  await sleep(100);
} else if (fixture.hang) {
  // Keep the event loop busy until SIGTERM/SIGKILL arrives (default
  // SIGTERM handling terminates the process, which is exactly what the
  // cancel tests assert).
  setInterval(() => {
    // keep the event loop alive
  }, 1000);
} else {
  process.exitCode = fixture.exitCode ?? 0;
}
