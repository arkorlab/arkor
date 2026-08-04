// Separate file from `hmr.test.ts` on purpose: `vi.mock("rolldown")`
// is module-hoisted and would fake the bundler for the whole file,
// but the sibling suite drives a REAL rolldown watcher end-to-end.
// This suite pins one contract only: a SYNCHRONOUS throw out of
// `watch()` (native watcher resource exhaustion, EACCES on the
// watched directory) must surface as a broadcast `error` frame, not
// escape `subscribe()` to the caller that just registered.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createHmrCoordinator, type HmrEvent } from "./hmr";

vi.mock("rolldown", () => ({
  watch: vi.fn(() => {
    throw new Error("EMFILE: too many open files, watch");
  }),
}));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-hmr-watchfail-test-"));
  mkdirSync(join(cwd, "src/arkor"), { recursive: true });
  writeFileSync(join(cwd, "src/arkor/index.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("createHmrCoordinator watcher-start failure", () => {
  it("broadcasts an error frame instead of letting a sync watch() throw escape subscribe()", async () => {
    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    try {
      // The old behaviour threw out of subscribe() here, AFTER the
      // subscriber had been added to the set: an orphaned
      // registration on a coordinator with no watcher.
      expect(() => {
        hmr.subscribe((e) => events.push(e));
      }).not.toThrow();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("error");
      expect(events[0]?.message).toMatch(
        /Failed to start the build watcher: .*EMFILE/,
      );
      // The manifest fast-path gate sees the error state too.
      expect(hmr.getLastEventType()).toBe("error");
    } finally {
      await hmr.dispose();
    }
  });
});
