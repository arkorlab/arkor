import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmrCoordinator, type HmrEvent } from "./hmr";

const FAKE_MANIFEST = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: { name: "alpha" },
});
`;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-hmr-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function nextEvent(
  events: HmrEvent[],
  predicate: (e: HmrEvent) => boolean,
  timeoutMs = 10_000,
): Promise<HmrEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `Timed out waiting for matching HMR event after ${timeoutMs}ms`,
          ),
        );
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("createHmrCoordinator", () => {
  it("emits a `ready` event after the first successful build", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      const ready = await nextEvent(events, (e) => e.type === "ready");
      expect(ready.outFile).toMatch(/\.arkor[\\/]+build[\\/]+index\.mjs$/);
      expect(typeof ready.hash).toBe("string");
    } finally {
      await hmr.dispose();
    }
  });

  it("emits a `rebuild` event after a source edit", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      const ready = await nextEvent(events, (e) => e.type === "ready");
      // Touch the entry with new content so the watcher detects a change.
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        FAKE_MANIFEST.replace(`"alpha"`, `"beta"`),
      );
      const rebuild = await nextEvent(events, (e) => e.type === "rebuild");
      expect(rebuild.outFile).toBe(ready.outFile);
      expect(rebuild.hash).not.toBe(ready.hash);
    } finally {
      await hmr.dispose();
    }
  });

  it("emits an `error` event when the entry is missing on subscribe", async () => {
    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      const err = await nextEvent(events, (e) => e.type === "error", 1000);
      expect(err.message).toMatch(/Build entry not found/);
    } finally {
      await hmr.dispose();
    }
  });

  it("replays the latest event to late subscribers", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const firstEvents: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => firstEvents.push(e));
    try {
      await nextEvent(firstEvents, (e) => e.type === "ready");
      // A new subscriber should receive the cached state synchronously
      // before any new build is triggered.
      //
      // We assert "the late subscriber sees the same event the prior one
      // saw last" rather than literally "ready" because rolldown@1.0.0-rc.17
      // on macOS occasionally fires a spurious second BUNDLE_END (FSEvents
      // coalescing inside the watcher) — there, `firstEvents` already
      // contains the spurious `rebuild` by the time we late-subscribe, and
      // the contract under test (replay of the cached state) holds either
      // way.
      // TODO(rolldown 1.0): re-check after rolldown leaves RC. If the
      // spurious BUNDLE_END is gone on macOS, tighten this back to
      //   expect(lateEvents[0]?.type).toBe("ready");
      const lateEvents: HmrEvent[] = [];
      hmr.subscribe((e) => lateEvents.push(e));
      expect(lateEvents.length).toBeGreaterThanOrEqual(1);
      expect(lateEvents[0]).toEqual(firstEvents[firstEvents.length - 1]);
    } finally {
      await hmr.dispose();
    }
  });

  it("stops broadcasting after dispose()", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    await nextEvent(events, (e) => e.type === "ready");
    await hmr.dispose();
    const countAfterDispose = events.length;

    // Edit after dispose must not produce any further events.
    writeFileSync(
      join(cwd, "src/arkor/index.ts"),
      FAKE_MANIFEST.replace(`"alpha"`, `"gamma"`),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(events.length).toBe(countAfterDispose);
  });
});
