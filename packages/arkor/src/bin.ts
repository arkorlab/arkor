#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { main } from "./cli/main";

/**
 * Re-exec ourselves with `--experimental-strip-types` if the Node invocation
 * that loaded this bin didn't already enable TypeScript stripping. Users'
 * training entries are authored in TypeScript and are imported dynamically by
 * `runTrainer`, so we need Node's built-in stripping to be available.
 *
 * Node 22.6+ supports the flag; 23+ enables it by default. Passing the flag
 * on newer Nodes is harmless.
 */
function hasStripTypesSupport(): boolean {
  const feat = (process.features as { typescript?: string }).typescript;
  if (feat === "strip" || feat === "transform") return true;
  return process.execArgv.some(
    (arg) =>
      arg === "--experimental-strip-types" ||
      arg === "--experimental-transform-types",
  );
}

if (!hasStripTypesSupport()) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings=ExperimentalWarning",
      process.argv[1]!,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // Catch top-level await rejections explicitly instead of letting Node's
  // default unhandled-rejection handler print them. Two reasons:
  //   1. Node's default formatter prints a code-frame with the source line at
  //      the throw site, and our bundled `dist/bin.mjs` is minified (a single
  //      line per top-level statement), so the "code frame" is one giant
  //      blob of JS that drowns the actual `Error: <message>` line.
  //   2. On macOS Node <22.17 (libuv <1.51.0) the `Error: <message>` tail of
  //      that output isn't reliably flushed to stderr before the process
  //      exits, so spawned-CLI test assertions that `toContain` the message
  //      fail with only the code-frame received. libuv 1.51.0 fixes this,
  //      but we want CI green across the whole supported Node range.
  // Setting `process.exitCode` (instead of `process.exit(1)`) lets the event
  // loop drain naturally so stderr fully flushes before exit.
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}
