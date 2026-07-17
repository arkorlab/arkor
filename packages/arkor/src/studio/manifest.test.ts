import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readManifestSummary } from "./manifest";

// A minimal, dependency-free `src/arkor/index.ts` runBuild can bundle.
const manifestSource = (trainerName: string) =>
  `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: ${JSON.stringify(trainerName)},
    start: async () => ({ jobId: "j1" }),
    wait: async () => ({ job: {}, artifacts: [] }),
    cancel: async () => {},
  },
});
`;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-manifest-test-"));
  mkdirSync(join(cwd, "src", "arkor"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("readManifestSummary cache-bust key", () => {
  // ENG-933 (code-review finding #4): the cache-bust query is a content hash,
  // not `Date.now()`. This test pins the property the hash guarantees and the
  // rejected keys do NOT: two reads with NO source edit reuse the SAME import
  // URL (so Node's ESM registry gains no new entry per home-page load), while
  // an edited source yields a DIFFERENT URL (so edits still surface). A
  // regression to `Date.now()` (a unique URL every call -> the module leak)
  // or to an mtime key (changes every rebuild) fails the first assertion.
  it("reuses one import URL across unedited reads and changes it after a source edit", async () => {
    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      manifestSource("qa-bot"),
    );

    const urls: string[] = [];
    const importSpy = vi.fn(async (u: string) => {
      urls.push(u);
      return (await import(u)) as Record<string, unknown>;
    });

    const first = await readManifestSummary(cwd, importSpy);
    const second = await readManifestSummary(cwd, importSpy);
    expect(first).toEqual({ trainer: { name: "qa-bot" } });
    expect(second).toEqual({ trainer: { name: "qa-bot" } });
    // Identical source -> byte-identical bundle -> identical hash -> same URL.
    expect(urls[0]).toBe(urls[1]);

    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      manifestSource("renamed-bot"),
    );
    const third = await readManifestSummary(cwd, importSpy);
    // Edited source -> different bundle -> different hash -> the edit surfaces.
    expect(third).toEqual({ trainer: { name: "renamed-bot" } });
    expect(urls[2]).not.toBe(urls[0]);
  });

  // PR #193 review (codex): Node's ESM registry caches FAILED evaluations by
  // URL too. A bundle whose top-level code threw because of an external
  // runtime condition (missing config file, ...) would stay a cached rejection
  // forever under a pure content-hash key, since fixing the condition doesn't
  // change the bundle bytes. After a failure the next read must use a fresh
  // URL (retry salt); once a salted URL succeeds it is reused.
  it("bumps the import URL after a failed import and reuses it after recovery", async () => {
    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      manifestSource("qa-bot"),
    );

    const urls: string[] = [];
    let failNext = true;
    const importSpy = vi.fn(async (u: string) => {
      urls.push(u);
      if (failNext) {
        failNext = false;
        throw new Error("external condition not met");
      }
      return (await import(u)) as Record<string, unknown>;
    });

    // First read: the module evaluation fails (external condition).
    await expect(readManifestSummary(cwd, importSpy)).rejects.toThrow(
      "external condition not met",
    );
    // Second read, source unchanged: a DIFFERENT URL, so the recovered
    // condition is picked up instead of Node's cached rejection.
    const second = await readManifestSummary(cwd, importSpy);
    expect(second).toEqual({ trainer: { name: "qa-bot" } });
    expect(urls[1]).not.toBe(urls[0]);
    // Third read: the successful salted URL is reused (no per-load growth).
    await readManifestSummary(cwd, importSpy);
    expect(urls[2]).toBe(urls[1]);
  });

  // PR #193 review (cubic): concurrent requests arriving while a post-failure
  // retry is still in flight must compute the SAME salted URL (Node then
  // coalesces the imports into one evaluation), not bump the salt once per
  // request and re-evaluate the user bundle per concurrent caller.
  it("shares one salted URL across concurrent retries after a failure", async () => {
    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      manifestSource("qa-bot"),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failFirst = true;
    const urls: string[] = [];
    const importSpy = vi.fn(async (u: string) => {
      urls.push(u);
      if (failFirst) {
        failFirst = false;
        throw new Error("external condition not met");
      }
      await gate; // hold both retries in flight until released
      return (await import(u)) as Record<string, unknown>;
    });

    // Seed the failure state.
    await expect(readManifestSummary(cwd, importSpy)).rejects.toThrow(
      "external condition not met",
    );
    // First retry: enters the import and blocks on the gate.
    const first = readManifestSummary(cwd, importSpy);
    await vi.waitFor(() => {
      expect(importSpy).toHaveBeenCalledTimes(2);
    });
    // Second, concurrent retry while the first is still in flight.
    const second = readManifestSummary(cwd, importSpy);
    await vi.waitFor(() => {
      expect(importSpy).toHaveBeenCalledTimes(3);
    });
    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ trainer: { name: "qa-bot" } });
    expect(r2).toEqual({ trainer: { name: "qa-bot" } });
    // Same salted URL for both concurrent retries: no per-request salt bump.
    expect(urls[2]).toBe(urls[1]);
  });

  // PR #193 review (coderabbit/cubic): retry state is tracked PER KEY. With a
  // single shared slot, another build's read in between would reset the
  // failed flag, and the failed build's next read would reuse Node's cached
  // rejection (the sticky failure the salt exists to prevent).
  it("keeps retry state per key so another build's read does not reset it", async () => {
    writeFileSync(
      join(cwd, "src", "arkor", "index.ts"),
      manifestSource("qa-bot"),
    );
    const otherCwd = mkdtempSync(join(tmpdir(), "arkor-manifest-other-"));
    mkdirSync(join(otherCwd, "src", "arkor"), { recursive: true });
    writeFileSync(
      join(otherCwd, "src", "arkor", "index.ts"),
      manifestSource("other-bot"),
    );
    try {
      const urls: string[] = [];
      let failFirst = true;
      const importSpy = vi.fn(async (u: string) => {
        urls.push(u);
        if (failFirst) {
          failFirst = false;
          throw new Error("external condition not met");
        }
        return (await import(u)) as Record<string, unknown>;
      });

      // Build A fails once.
      await expect(readManifestSummary(cwd, importSpy)).rejects.toThrow(
        "external condition not met",
      );
      // Build B (a different key) succeeds in between.
      await expect(readManifestSummary(otherCwd, importSpy)).resolves.toEqual({
        trainer: { name: "other-bot" },
      });
      // Build A's next read must still bump ITS salt (fresh URL), not have
      // been reset by B's read into reusing the cached-failed base URL.
      await expect(readManifestSummary(cwd, importSpy)).resolves.toEqual({
        trainer: { name: "qa-bot" },
      });
      expect(urls[2]).not.toBe(urls[0]);
      expect(urls[2]).toContain("&r=1");
      // B was never salted (its key never failed).
      expect(urls[1]).not.toContain("&r=");
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});
