#!/usr/bin/env node
import process from "node:process";
import { ClaudeCodeStrictExit } from "@arkor/cli-internal";
import { main } from "./cli/main";

// Catch top-level await rejections explicitly instead of letting Node's
// default unhandled-rejection handler print them: the bundled `dist/bin.mjs`
// is minified, so Node's code-frame at the throw site is one giant blob of
// JS that drowns the actual `Error: <message>` line. Setting
// `process.exitCode` (instead of `process.exit(1)`) lets the event loop
// drain naturally so stderr fully flushes before exit.
try {
  await main(process.argv.slice(2));
} catch (err) {
  // `ClaudeCodeStrictExit` is thrown by the strict-mode validator after
  // it has already written the missing-flags block to stderr. Throwing
  // (rather than `process.exit(1)`-ing inside the action) lets main's
  // `finally` run telemetry shutdown + any deprecation notice; here we
  // just set the exit code without re-printing the message or its stack.
  if (err instanceof ClaudeCodeStrictExit) {
    process.exitCode = 1;
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}
