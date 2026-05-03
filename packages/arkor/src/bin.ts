#!/usr/bin/env node
import process from "node:process";
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
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
}
