import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  moduleCacheBustKey,
  moduleCacheBustUrl,
} from "./moduleCacheBust";

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
    // mtime+size keying must collapse repeat reads of unchanged
    // bytes onto the same key so the loader serves from cache.
    const file = join(dir, "stable.mjs");
    writeFileSync(file, "export const v = 1;");
    const k1 = moduleCacheBustKey(file);
    const k2 = moduleCacheBustKey(file);
    expect(k1).toBe(k2);
    // mtimeMs-ctimeMs-size; mtimeMs/ctimeMs may carry sub-ms precision
    // (no `toFixed(0)`) so digits include an optional fractional part.
    expect(k1).toMatch(/^[\d.]+-[\d.]+-\d+$/);
  });

  it("changes when the file content changes (different size)", () => {
    const file = join(dir, "growing.mjs");
    writeFileSync(file, "v1");
    const before = moduleCacheBustKey(file);
    writeFileSync(file, "version-two");
    const after = moduleCacheBustKey(file);
    expect(after).not.toBe(before);
  });

  it("returns a stable fallback (\"0-0-0\") for missing files instead of throwing", () => {
    // The eventual `await import(url)` will throw on a missing
    // file; the helper itself should produce a value rather than
    // bubbling the stat error and turning every consumer into a
    // try/catch site. Three zeros — one each for mtimeMs, ctimeMs,
    // size — to keep the shape uniform with the success branch.
    expect(moduleCacheBustKey(join(dir, "does-not-exist.mjs"))).toBe("0-0-0");
  });
});

describe("moduleCacheBustUrl", () => {
  it("returns a fully-qualified file URL with the cache-bust query attached", () => {
    const file = join(dir, "u.mjs");
    writeFileSync(file, "export const x = 1;");
    const url = moduleCacheBustUrl(file);
    expect(url.startsWith(pathToFileURL(file).href + "?t=")).toBe(true);
    expect(url).toMatch(/\?t=[\d.]+-[\d.]+-\d+$/);
  });
});
