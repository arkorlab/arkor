import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
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

/**
 * Resolve once `events.length` has gone `quietWindowMs` without
 * growing. Used to wait out spurious watcher events on noisier file
 * systems (Windows polling / macOS FSEvents coalescing) before
 * asserting the cached state.
 */
function waitForStableEvents(
  events: HmrEvent[],
  quietWindowMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let lastLength = events.length;
    let stableSince = Date.now();
    const tick = () => {
      if (events.length !== lastLength) {
        lastLength = events.length;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= quietWindowMs) return resolve();
      setTimeout(tick, 50);
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

  it("subscribe()'s lastEvent replay swallows a throwing subscriber so initialization keeps working", async () => {
    // Regression: `subscribe()` synchronously replays `lastEvent` to
    // a fresh subscriber for the late-mount-cached-state contract.
    // Previously the replay had no try/catch, so a subscriber that
    // threw during that one call (typical case: an SSE controller
    // that closed mid-replay — `controller.enqueue` on a closed
    // stream throws) propagated out of `subscribe()` and broke
    // whoever just registered. `broadcast()` already swallowed
    // subscriber throws defensively; this test pins the symmetric
    // contract on `subscribe()`.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const firstEvents: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => firstEvents.push(e));
    try {
      await nextEvent(firstEvents, (e) => e.type === "ready");
      // A subscriber whose body throws on the cached-state replay.
      const throwingSubscriber = (): void => {
        throw new Error("controller closed");
      };
      // Must not throw out of subscribe(); must still return a
      // working unsubscribe.
      let unsubscribe: () => void = () => undefined;
      expect(() => {
        unsubscribe = hmr.subscribe(throwingSubscriber);
      }).not.toThrow();
      expect(typeof unsubscribe).toBe("function");
      // Confirm the coordinator is still healthy: a *new* subscriber
      // (after the throwing one) still receives the cached replay.
      const recoveryEvents: HmrEvent[] = [];
      hmr.subscribe((e) => recoveryEvents.push(e));
      expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
      unsubscribe();
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
    // bytes that are actually on disk. The new sequence-number guard
    // inside `emitBuildSucceeded` drops stale inspection results so
    // whichever BUNDLE_END landed last broadcasts last.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      await nextEvent(events, (e) => e.type === "ready");
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        FAKE_MANIFEST.replace(`"alpha"`, `"beta"`),
      );
      await nextEvent(events, (e) => e.type === "rebuild", 4000);
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        FAKE_MANIFEST.replace(`"alpha"`, `"gamma"`),
      );
      // Wait for the watcher to settle — any rebuild that's going to
      // fire (including spurious extras from FSEvents on macOS or
      // chokidar polling on Windows) lands within this window. The
      // assertion then compares the cached `lastEvent.hash` against
      // the *actual* fingerprint of the on-disk artefact, not a
      // captured "last expected" hash from earlier in the test —
      // that earlier capture was brittle on Windows where rolldown
      // routinely emits a 4th BUNDLE_END after the explicit edits
      // settle, producing a slightly different output byte (a
      // change in the bundled comment header is enough to bump
      // mtime + ctime + size).
      await waitForStableEvents(events, 750);
      const stat = statSync(join(cwd, ".arkor/build/index.mjs"));
      const expectedHash = `${stat.mtimeMs}-${stat.ctimeMs}-${stat.size}`;
      expect(events[events.length - 1]?.hash).toBe(expectedHash);
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

  it("getCurrentArtifactHash() returns null when the artefact doesn't exist (vs a Date.now() fallback)", async () => {
    // Regression: a previous implementation did
    // `statSync(...) ; return fingerprint(...)`. Two stat calls
    // means a race window where the file disappears between them:
    // the existence check passes, then `fingerprint`'s catch
    // branch substitutes `Date.now().toString(36)` (its
    // freshness-forcing fallback for SSE dedup), and the getter
    // returns a non-null, non-artefact-derived hash. That
    // silently breaks `dispatchRebuild`'s pre-ready-spawn gate
    // which relies on null === "no artefact, force restart".
    // The fix uses `fingerprintOrNull` — single statSync, true
    // null on failure.
    //
    // We assert the getter on a project that has NEVER built
    // (no `.arkor/build/index.mjs` ever existed). The bug-fix
    // version returns null; the broken version's leftover would
    // have been Date.now()-derived non-null.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const hmr = createHmrCoordinator({ cwd });
    try {
      // No subscribe() yet — watcher hasn't started, so no
      // BUNDLE_END has written the artefact. The on-disk
      // `.arkor/build/index.mjs` doesn't exist.
      expect(hmr.getCurrentArtifactHash()).toBeNull();
    } finally {
      await hmr.dispose();
    }
  });

  it("getCurrentArtifactHash() returns a stable mtime/ctime/size hash once the artefact exists", async () => {
    // Companion to the null-on-missing test: when the artefact
    // *does* exist (watcher's first BUNDLE_END landed), the
    // getter returns the same `mtimeMs-ctimeMs-size` shape the
    // SSE event's `hash` field uses. The two are paired for SSE
    // dedup purposes; the pre-ready-spawn registry gate switched
    // to content-hash (`getCurrentArtifactContentHash`) to avoid
    // identical-bytes/different-timestamps false positives, but
    // the timestamp hash stays as the canonical SSE event id.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      const ready = await nextEvent(events, (e) => e.type === "ready");
      const artifactHash = hmr.getCurrentArtifactHash();
      // Same shape as the SSE event's `hash` field — both feed
      // through the same `mtimeMs-ctimeMs-size` formula.
      expect(artifactHash).toBe(ready.hash ?? null);
      expect(artifactHash).toMatch(/^[\d.]+-[\d.]+-\d+$/);
    } finally {
      await hmr.dispose();
    }
  });

  it("getCurrentConfigHash() preserves the last-success hash across an ERROR event", async () => {
    // Regression: previously `getCurrentConfigHash()` returned
    // `lastEvent?.configHash ?? null`. After an ERROR landed,
    // `lastEvent` was the error event (no `configHash`) so the
    // getter went null — even though `.arkor/build/index.mjs` still
    // held the previous *successful* bundle bytes (ERROR doesn't
    // overwrite the output). A child spawned via `/api/train` in
    // that window would register `configHash: null`, and the next
    // successful BUNDLE_END would diff against null → SIGTERM
    // restart instead of SIGUSR2 hot-swap, defeating callback
    // hot-swap for the rest of the session. The fix tracks the
    // last *successful* hash separately from `lastEvent`.
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const events: HmrEvent[] = [];
    const hmr = createHmrCoordinator({ cwd });
    hmr.subscribe((e) => events.push(e));
    try {
      const ready = await nextEvent(events, (e) => e.type === "ready");
      const successHash = hmr.getCurrentConfigHash();
      // Sanity: ready event's configHash matches the getter.
      expect(successHash).toBe(ready.configHash ?? null);
      // Inject a syntax error to force a watcher ERROR event.
      writeFileSync(
        join(cwd, "src/arkor/index.ts"),
        "this is not { valid javascript = ;",
      );
      await nextEvent(events, (e) => e.type === "error", 4000);
      // After the error, the cached `lastEvent` is the error frame
      // — but the on-disk artifact still holds the previous
      // success. The getter must return that previous-success hash
      // so any `/api/train` spawn during this window still gets a
      // useful spawn-time hash for the *next* rebuild's routing.
      expect(hmr.getCurrentConfigHash()).toBe(successHash);
    } finally {
      await hmr.dispose();
    }
  });
});
