import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../harness/fixture";

/**
 * Rewrite the seeded `src/arkor/index.ts` with a new trainer `name`
 * (and arbitrary content tail to bump mtime + size beyond any
 * sub-millisecond resolution noise on fast filesystems). We rewrite
 * the WHOLE file (not append) so rolldown's incremental cache can't
 * reuse the prior module record and skip the rebuild.
 *
 * Two key shape differences from `seedFixture.ts`'s `seedManifest`:
 *
 *  1. The trainer carries the `Symbol.for("arkor.trainer.inspect")`
 *     brand so `findInspectableTrainer` (used by `studio/hmr.ts`'s
 *     `inspectBundle`) can read its name + config — without the
 *     brand, every SSE rebuild frame gets `trainerName: null` and
 *     the SSE-level test below can't distinguish the post-edit
 *     rebuild from the cached initial-build replay. The seed
 *     fixture skips the brand because its existing tests only
 *     exercise the `/api/manifest` path (which uses
 *     `findTrainerInModule`, brand-less) — extending it would
 *     couple every test to inspection internals it doesn't care
 *     about.
 *
 *  2. The brand returns a real `JobConfig` shape (`model` +
 *     `datasetSource` set), not the seed's empty placeholder, so
 *     `hashJobConfig` produces a stable non-empty `configHash`.
 *     `studio/server.ts`'s `dispatchRebuild` consults that hash to
 *     route between SIGUSR2 hot-swap and SIGTERM restart; the
 *     existing E2E only tests the boot path so it never needs a
 *     real config there.
 *
 * `Symbol.for` keys round-trip across the dev process / built
 * bundle realm boundary because they live in the global symbol
 * registry — same mechanism `core/trainerInspection.ts` documents
 * for the runtime CLI / `.arkor/build/index.mjs` split.
 */
function rewriteManifest(projectDir: string, name: string): void {
  const path = join(projectDir, "src", "arkor", "index.ts");
  writeFileSync(
    path,
    [
      'const TRAINER_INSPECT_KEY = Symbol.for("arkor.trainer.inspect");',
      "const trainer = {",
      `  name: ${JSON.stringify(name)},`,
      "  start: async () => ({ id: 'e2e-job', url: '' }),",
      "  wait: async () => ({ status: 'completed' as const }),",
      "  cancel: async () => {},",
      "};",
      "Object.defineProperty(trainer, TRAINER_INSPECT_KEY, {",
      "  value: () => ({",
      "    name: trainer.name,",
      "    config: {",
      '      model: "studio-e2e-model",',
      '      datasetSource: { type: "huggingface" as const, name: "studio-e2e-dataset" },',
      "    },",
      "    callbacks: {},",
      "  }),",
      "  enumerable: false,",
      "});",
      'export const arkor = { _kind: "arkor" as const, trainer };',
      "export default arkor;",
      `// rewritten-${name}-${Date.now()}`,
      "",
    ].join("\n"),
  );
}

interface SseFrame {
  event: string;
  data: string;
}

/**
 * Open `/api/dev/events`, parse incoming SSE frames, and resolve when
 * `predicate` first returns true. Cleans up the underlying body
 * reader on resolve / reject so the Hono server's connection bookkeeping
 * doesn't leak between tests.
 *
 * `arkor dev` requires the studio token via the query param (EventSource
 * can't set headers); the same allow-list governs `fetch()` here.
 */
async function awaitSseFrame(
  studioUrl: string,
  token: string,
  predicate: (frame: SseFrame) => boolean,
  timeoutMs: number,
): Promise<SseFrame> {
  const url = `${studioUrl}/api/dev/events?studioToken=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(
      `SSE connect failed for ${url}: ${(err as Error).message}`,
    );
  }
  if (!res.ok || !res.body) {
    clearTimeout(timeout);
    throw new Error(
      `SSE connect returned ${res.status} ${res.statusText}; body=${
        res.body ? "present" : "missing"
      }`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("SSE stream ended before predicate matched");
      }
      buf += decoder.decode(value, { stream: true });
      // Frames are terminated by a blank line (`\n\n`). Split, keep
      // the trailing partial in `buf` for the next iteration.
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const raw of parts) {
        if (!raw) continue;
        let event = "";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        const frame: SseFrame = { event, data };
        if (predicate(frame)) return frame;
      }
    }
  } finally {
    clearTimeout(timeout);
    // Cancel rather than just release: cancel propagates to the Hono
    // ReadableStream's `cancel()` handler so the server unsubscribes
    // this listener from the HMR coordinator promptly. Otherwise the
    // listener lingers until the next dispose, which can produce
    // cross-test bleed when running with `--repeat-each`.
    await reader.cancel().catch(() => {});
  }
}

test.describe("Studio HMR", () => {
  test("/api/dev/events is registered with the hmr-enabled meta tag", async ({
    page,
    studio,
  }) => {
    // Boot-time wiring: `arkor dev` always wires up the HMR
    // coordinator, so the served HTML must carry both the
    // studio-token meta and the hmr-enabled meta. Without the
    // hmr-enabled tag, `isHmrEnabled()` returns false in the SPA
    // and the auto-restart / hot-swap paths silently no-op.
    await page.goto(studio.url);
    const hmrMeta = page.locator('meta[name="arkor-hmr-enabled"]');
    await expect(hmrMeta).toHaveCount(1);
    await expect(hmrMeta).toHaveAttribute("content", "true");

    // Endpoint sanity-check: a GET without the studio token must 403
    // (regression for the CSRF allow-list — `eventStreamPathPattern`
    // permits the query-token form, but a raw GET stays gated).
    const noToken = await fetch(`${studio.url}/api/dev/events`);
    expect(noToken.status).toBe(403);
  });

  test("editing src/arkor/index.ts broadcasts a rebuild SSE frame with the new trainer name", async ({
    studio,
    fixturePaths,
  }) => {
    // Edit BEFORE subscribing, then let the predicate filter out
    // pre-edit replays. The watcher may already have a cached
    // initial-build `ready` (with the seed name) by the time we
    // connect; subscribing first then editing would force a
    // drain step. Going edit → subscribe is simpler: the
    // predicate explicitly requires `trainerName === newName`,
    // which only the post-edit BUNDLE_END can satisfy — any
    // cached or in-flight frame for the seed name fails the
    // predicate and `awaitSseFrame` keeps reading until the
    // matching one arrives.
    const newName = "studio-e2e-trainer-edited";
    rewriteManifest(fixturePaths.projectDir, newName);

    const frame = await awaitSseFrame(
      studio.url,
      studio.token,
      (f) => {
        if (f.event !== "rebuild" && f.event !== "ready") return false;
        // Some replays have empty data; skip those.
        if (!f.data) return false;
        try {
          const parsed = JSON.parse(f.data) as {
            trainerName?: string | null;
          };
          return parsed.trainerName === newName;
        } catch {
          return false;
        }
      },
      // Generous: rolldown's first cold build on a fresh project
      // can take 1–2s on a slow CI runner; the post-edit rebuild is
      // typically faster (incremental) but we don't want to flake on
      // a noisy host.
      20_000,
    );

    expect(frame.event === "rebuild" || frame.event === "ready").toBe(true);
    const parsed = JSON.parse(frame.data) as {
      outFile?: string;
      trainerName?: string | null;
      configHash?: string | null;
    };
    expect(parsed.trainerName).toBe(newName);
    // The artefact path is also part of the contract: HMR consumers
    // (including the runner subprocess on SIGUSR2) re-import the
    // bundle by `outFile`. A regression that drops it would silently
    // disable hot-swap.
    expect(parsed.outFile).toMatch(/\.arkor[\\/]build[\\/]index\.mjs$/);
  });

  test("/api/manifest reflects the edited trainer name after a save", async ({
    studio,
    fixturePaths,
  }) => {
    // End-to-end through the Hono `/api/manifest` route, which
    // dynamic-imports the freshly-built artefact via
    // `summariseBuiltManifest`. The HMR rebuild must have completed
    // *and* the cache-bust URL must reflect the new bytes for this
    // assertion to pass — exercises the rebuild → write artefact →
    // re-import → return summary chain end-to-end.
    const newName = `studio-e2e-trainer-renamed-${Date.now()}`;
    rewriteManifest(fixturePaths.projectDir, newName);

    await expect
      .poll(
        async () => {
          const res = await fetch(`${studio.url}/api/manifest`, {
            headers: { "X-Arkor-Studio-Token": studio.token },
          });
          if (!res.ok) return null;
          const body = (await res.json()) as {
            trainer?: { name?: string } | null;
          };
          return body.trainer?.name ?? null;
        },
        {
          // Same 20s budget as the SSE test for the same reason: the
          // first rebuild after spawn can be slow on cold CI. Keep
          // the poll interval modest so we don't hammer the dev
          // loop's `runBuild` faster than it can settle.
          timeout: 20_000,
          intervals: [200, 400, 800, 1500],
        },
      )
      .toBe(newName);
  });

  test("the SPA Run Training caption updates without a page reload after a save", async ({
    page,
    studio,
    fixturePaths,
  }) => {
    // End-to-end browser proof: the SPA's RunTraining component
    // subscribes to `/api/dev/events`, calls `fetchManifest()` on
    // each rebuild, and re-renders the trainer caption. Reloading
    // the page would mask any regression in that subscription path,
    // so we explicitly DO NOT navigate again after the edit.
    await page.goto(studio.url);
    await expect(page.getByText(/studio-e2e-trainer/).first()).toBeVisible();

    const newName = `studio-e2e-trainer-live-${Date.now()}`;
    rewriteManifest(fixturePaths.projectDir, newName);

    // The new name should appear without a navigation. Match by
    // substring rather than exact text so the surrounding "Trainer
    // <name> from src/arkor/index.ts" caption decoration doesn't
    // need to be replicated here.
    await expect(page.getByText(newName).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
