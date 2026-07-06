import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleCacheBustKey, moduleCacheBustUrl } from "./moduleCacheBust";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arkor-cachebust-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("moduleCacheBustKey", () => {
  it("is stable across calls when the file hasn't changed", () => {
    // Regression: Node's ESM loader never evicts module records, and
    // a `Date.now()` cache-bust would produce a fresh URL on every
    // call → unbounded leak across long `arkor dev` sessions
    // (5 s `/api/manifest` polls + every save firing SIGUSR2).
    // Content keying must collapse repeat reads of unchanged bytes
    // onto the same key so the loader serves from cache.
    const file = join(dir, "stable.mjs");
    writeFileSync(file, "export const v = 1;");
    const k1 = moduleCacheBustKey(file);
    const k2 = moduleCacheBustKey(file);
    expect(k1).toBe(k2);
    // Truncated sha256 of the file bytes: 16 lowercase hex chars.
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the file content changes", () => {
    const file = join(dir, "growing.mjs");
    writeFileSync(file, "v1");
    const before = moduleCacheBustKey(file);
    writeFileSync(file, "version-two");
    const after = moduleCacheBustKey(file);
    expect(after).not.toBe(before);
  });

  it("changes for same-size different-content edits landing in the same timestamp tick", () => {
    // Regression for the stat-key collision: the previous
    // `mtimeMs-ctimeMs-size` key could collide when two writes of the
    // same byte length landed within one kernel timestamp tick
    // (~1-10 ms granularity on common Linux configs), making Node's
    // loader return the STALE module for the second build. Pin the
    // timestamps to identical values explicitly so the test is
    // deterministic rather than racing the kernel clock: with a
    // content-derived key the timestamps must not matter at all.
    const file = join(dir, "same-size.mjs");
    writeFileSync(file, "export const v = 'aaaa';");
    const pinned = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(file, pinned, pinned);
    const before = moduleCacheBustKey(file);
    writeFileSync(file, "export const v = 'bbbb';");
    utimesSync(file, pinned, pinned);
    const after = moduleCacheBustKey(file);
    expect(after).not.toBe(before);
  });

  it("is stable when the file is rewritten with identical bytes (timestamps bump, content doesn't)", () => {
    // The watcher's staging-rename publish bumps mtime/ctime even when
    // the rebuilt bundle is byte-identical. The content key must reuse
    // the existing ESM record in that case (one record per distinct
    // content, not per publish).
    const file = join(dir, "identical.mjs");
    writeFileSync(file, "export const v = 1;");
    const before = moduleCacheBustKey(file);
    writeFileSync(file, "export const v = 1;");
    const after = moduleCacheBustKey(file);
    expect(after).toBe(before);
  });

  it("returns a UNIQUE fallback token per call for missing files instead of throwing", () => {
    // The eventual `await import(url)` will throw on a missing file;
    // the helper itself should produce a value rather than bubbling
    // the read error and turning every consumer into a try/catch
    // site. The token must be unique per failure: a stable sentinel
    // (the previous "0-0-0") could cache a module under it when the
    // file appeared between key time and the loader's read, and every
    // later missing-file call would then silently get that stale
    // module instead of a clean import error.
    const missing = join(dir, "does-not-exist.mjs");
    const k1 = moduleCacheBustKey(missing);
    const k2 = moduleCacheBustKey(missing);
    expect(k1).toMatch(/^miss-\d+$/);
    expect(k2).toMatch(/^miss-\d+$/);
    expect(k1).not.toBe(k2);
  });
});

describe("moduleCacheBustUrl", () => {
  it("returns a fully-qualified file URL with the cache-bust query attached", () => {
    const file = join(dir, "u.mjs");
    writeFileSync(file, "export const x = 1;");
    const url = moduleCacheBustUrl(file);
    expect(url.startsWith(pathToFileURL(file).href + "?t=")).toBe(true);
    expect(url).toMatch(/\?t=[0-9a-f]{16}$/);
  });
});
