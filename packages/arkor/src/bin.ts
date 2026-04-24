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
  await main(process.argv.slice(2));
}
