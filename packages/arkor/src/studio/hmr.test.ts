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

  it("transitions from `error` to `ready` once the entry appears, without re-subscribing", async () => {
    // Regression: previously `startWatcher` bailed out and never
    // retried, so an SPA already connected to `/api/dev/events` against
    // a fresh scaffold would be stuck on the initial `error` event
    // forever — EventSource doesn't reconnect on application-level
    // errors. The coordinator now polls for the entry file in the
    // background and starts the watcher the moment it appears.
    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      await nextEvent(events, (e) => e.type === "error", 1000);
      // Same subscriber — no reconnect, no second `subscribe` call.
      mkdirSync(join(cwd, "src/arkor"), { recursive: true });
      writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);
      const ready = await nextEvent(
        events,
        (e) => e.type === "ready",
        4000,
      );
      expect(ready.outFile).toMatch(/index\.mjs$/);
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

  it("the cached lastEvent reflects the LATEST source under rapid back-to-back edits", async () => {
    // Regression: the BUNDLE_END handler used to fire
    // `emitBuildSucceeded` without awaiting, so two quick rebuilds
    // could run `inspectBundle` concurrently and broadcast out of
    // order — leaving `lastEvent` pointing at the older snapshot.
    // We can't deterministically synthesise a race against rolldown's
    // real watcher, but we *can* assert the user-visible invariant:
    // after a sequence of edits, the cached state must match the
    // last write. The new sequence-number guard inside
    // `emitBuildSucceeded` drops stale inspection results so the
    // final broadcast always wins.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      await nextEvent(events, (e) => e.type === "ready");
      // Two source edits in quick succession. Both must result in a
      // broadcast eventually, and `lastEvent.hash` must end up
      // matching the file content of the FINAL write — not the
      // first one (which would prove the older inspection raced
      // past the newer one's broadcast).
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        FAKE_MANIFEST.replace(`"alpha"`, `"beta"`),
      );
      const v2 = await nextEvent(
        events,
        (e) => e.type === "rebuild",
        4000,
      );
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        FAKE_MANIFEST.replace(`"alpha"`, `"gamma"`),
      );
      // Wait for any rebuild whose hash differs from v2's. Without
      // the seq guard the older inspection could clobber the cached
      // state with v2 again, so this would time out.
      const v3 = await nextEvent(
        events,
        (e) => e.type === "rebuild" && e.hash !== v2.hash,
        4000,
      );
      // Settle: give any in-flight inspection time to land so we can
      // assert the final cached state really is v3, not a late v2
      // overwrite.
      await new Promise((r) => setTimeout(r, 250));
      expect(events[events.length - 1]?.hash).toBe(v3.hash);
    } finally {
      await hmr.dispose();
    }
  });

  it("getCurrentConfigHash() returns the latest cached event's hash", async () => {
    // Regression: `/api/train` previously called `readManifestSummary`
    // and ran a redundant rebuild per spawn (racing the watcher).
    // The new server flow reads the cached hash via
    // `getCurrentConfigHash()`. We can't trigger a real build here
    // (the user-bundle entry shape would need a working `arkor`
    // resolution at import time), but we can verify the getter
    // returns `null` before the watcher has emitted any event and
    // tracks the cached event's `configHash` field once one lands.
    // The integration of "configHash actually populated for all
    // entry shapes" is covered by the unit test against
    // `findInspectableTrainer` in `trainerInspection.test.ts`.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    // Before any subscriber attaches, no watcher is running and no
    // event has been broadcast — getter must return null without
    // throwing.
    expect(hmr.getCurrentConfigHash()).toBeNull();
    hmr.subscribe((e) => events.push(e));
    try {
      const ready = await nextEvent(events, (e) => e.type === "ready");
      // FAKE_MANIFEST is hand-rolled (no SDK brand) so the cached
      // hash is null — but the *getter* must still return whatever
      // the cached event carries, not throw.
      expect(hmr.getCurrentConfigHash()).toBe(ready.configHash ?? null);
    } finally {
      await hmr.dispose();
    }
  });
});
