import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  LOCAL_BACKEND_ENV,
  LOCAL_SERVER_TOKEN_ENV,
  LOCAL_SERVER_URL_ENV,
} from "../../core/local-mode";
import { runTrainer } from "../../core/runner";
import { loadLocalRuntime } from "../local-runtime-loader";

import { runBuild } from "./build";

import type { LoadedLocalServer } from "../local-runtime-loader";

export interface StartOptions {
  /**
   * Optional entry override. When provided the project is rebuilt with this
   * entry before running. When omitted, an existing build artifact is reused
   * (and built on-demand if missing).
   */
  entry?: string;
  /** Output directory; defaults to `.arkor/build`. */
  outDir?: string;
  /** Project root; defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Run the training on this machine via the `@arkor/local` runtime instead
   * of Arkor Cloud.
   */
  local?: boolean;
  /** Local backend id override (`--backend <id>`); auto-detects when unset. */
  backend?: string;
}

const DEFAULT_OUT_DIR = ".arkor/build";

/**
 * Execute the build artifact at `.arkor/build/index.mjs`. Mirrors `next start`:
 * the user's TS has already been compiled by `arkor build`, and this command
 * just imports the artifact and dispatches to the discovered trainer.
 *
 * For ergonomics (and so Studio's "Run training" button doesn't have to chain
 * two spawns), `start` auto-runs `build` when no artifact exists, or when an
 * explicit entry is provided.
 *
 * With `--local`, a local training server is booted in-process first and
 * handed to the trainer through the env contract in `core/local-mode.ts`.
 * When the hand-off is already present in the environment (this process is a
 * child of `arkor dev --local`'s Studio server), the existing server is
 * reused so Studio-triggered runs land in the same job store the Studio UI
 * reads.
 */
export async function runStart(opts: StartOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  const outFile = resolve(outDir, "index.mjs");

  let localServer: LoadedLocalServer | null = null;
  if (opts.local && !process.env[LOCAL_SERVER_URL_ENV]) {
    const runtime = await loadLocalRuntime(cwd);
    localServer = await runtime.startServer({
      cwd,
      backendId: opts.backend ?? process.env[LOCAL_BACKEND_ENV],
    });
    // Must be set BEFORE the dynamic import below: the user bundle
    // constructs its trainer at module-import time with the project's own
    // arkor copy, and the env contract is the only channel that reaches it.
    process.env[LOCAL_SERVER_URL_ENV] = localServer.url;
    process.env[LOCAL_SERVER_TOKEN_ENV] = localServer.token;
    console.log(
      `Local training via ${localServer.backend.displayName} at ${localServer.url}`,
    );
  }

  try {
    const needsBuild = Boolean(opts.entry) || !existsSync(outFile);
    if (needsBuild) {
      await runBuild({ cwd, outDir: outDirRel, entry: opts.entry });
    }

    await runTrainer(outFile);
  } finally {
    if (localServer) {
      // The server owns training/inference children; closing it reaps them.
      await localServer.close();
      // Reflect.deleteProperty instead of `delete` with a computed key: the
      // env names live in core/local-mode.ts as the single source of truth,
      // and assigning `undefined` would store the string "undefined".
      Reflect.deleteProperty(process.env, LOCAL_SERVER_URL_ENV);
      Reflect.deleteProperty(process.env, LOCAL_SERVER_TOKEN_ENV);
    }
  }
}
