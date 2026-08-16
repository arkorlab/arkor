import { mlxBackend } from "./mlx";

import type { LocalTrainingBackend } from "./types";

/**
 * All known local training backends, in auto-detection order (the first one
 * whose preflight passes wins).
 *
 * Adding a backend (the roadmap plans CUDA and ROCm for Linux / Windows
 * NVIDIA and AMD GPUs) means:
 *   1. a new `backends/<id>.ts` implementing {@link LocalTrainingBackend},
 *      with all of its platform / GPU probing inside `preflight`,
 *   2. a Python shim under `python/<id>/` speaking the JSON-line contract
 *      in `protocol.ts`,
 *   3. one entry here.
 * The store, runner, server, and inference manager are backend-agnostic and
 * need no changes.
 */
export const LOCAL_BACKENDS: readonly LocalTrainingBackend[] = Object.freeze([
  mlxBackend,
]);
