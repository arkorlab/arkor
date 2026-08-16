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
 *       "adapterDirs": string[] directories to create with an
 *                               adapter_config.json inside (relative to the
 *                               job dir)
 *     }
 *   }
 */
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

if (fixture.hang) {
  // Keep the event loop busy until SIGTERM/SIGKILL arrives (default
  // SIGTERM handling terminates the process, which is exactly what the
  // cancel tests assert).
  setInterval(() => {
    // keep the event loop alive
  }, 1000);
} else {
  process.exitCode = fixture.exitCode ?? 0;
}
