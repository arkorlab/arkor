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
});
