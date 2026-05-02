import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-scoped mock for node:child_process so we can simulate `git`
// terminating via signal (close handler arg `code` is `null` per Node
// docs in that case). The branch `code ?? -1` in git.ts's tryGit is
// otherwise unreachable from a real subprocess in a hermetic test.
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import { gitInitialCommit } from "./git";

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gitInitialCommit signal handling", () => {
  it("falls back to commit.gpgsign=false when the first commit was killed by a signal", async () => {
    // Sequence of spawns inside gitInitialCommit:
    //   1. `git init -q`            → exits 0
    //   2. `git add -A`             → exits 0
    //   3. `git commit -q -m …`     → killed (close with code=null) +
    //      stderr containing a signing-failure marker so the helper
    //      treats it as a signing failure and retries unsigned.
    //   4. `git -c commit.gpgsign=false commit -q -m …` → exits 0
    //
    // Step 3's null-code → `code ?? -1` resolves the tryGit promise with
    // `{ code: -1 }` and the stderr triggers the looksLikeSigningFailure
    // regex so we hit the fallback path.
    const order: FakeChild[] = [];
    vi.mocked(spawn).mockImplementation((() => {
      const child = makeChild();
      order.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);

    const promise = gitInitialCommit("/anywhere", "msg");

    // Yield once so the implementation registers its `error`/`close`
    // listeners on the first child before we emit on it.
    await Promise.resolve();
    order[0]!.emit("close", 0); // git init
    await Promise.resolve();
    order[1]!.emit("close", 0); // git add
    await Promise.resolve();

    // git commit (signed, killed by signal): stderr triggers fallback,
    // then close with `code=null` exercises the `?? -1` branch.
    order[2]!.stderr.emit(
      "data",
      Buffer.from("error: gpg failed to sign the data\n"),
    );
    order[2]!.emit("close", null);
    await Promise.resolve();

    // Final retry succeeds.
    order[3]!.emit("close", 0);

    const result = await promise;
    expect(result.signingFallback).toBe(true);
    // Sanity: spawn was called for each of the four phases.
    expect(spawn).toHaveBeenCalledTimes(4);
  });
});
