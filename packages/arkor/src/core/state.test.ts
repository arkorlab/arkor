import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  readState,
  writeState,
  statePath,
  clearStaleProjectState,
} from "./state";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-state-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("state", () => {
  it("returns null when the file is missing", async () => {
    expect(await readState(cwd)).toBeNull();
  });

  it("round-trips state through writeState/readState", async () => {
    const state = {
      orgSlug: "my-org",
      projectSlug: "my-project",
      projectId: "pid-1",
    };
    await writeState(state, cwd);
    expect(await readState(cwd)).toEqual(state);
  });

  it("writes to <cwd>/.arkor/state.json", async () => {
    await writeState({ orgSlug: "o", projectSlug: "p", projectId: "pid" }, cwd);
    expect(statePath(cwd)).toBe(join(cwd, ".arkor", "state.json"));
  });

  it("returns null when the file is malformed JSON", async () => {
    mkdirSync(join(cwd, ".arkor"), { recursive: true });
    writeFileSync(join(cwd, ".arkor", "state.json"), "{not json");
    expect(await readState(cwd)).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    mkdirSync(join(cwd, ".arkor"), { recursive: true });
    writeFileSync(
      join(cwd, ".arkor", "state.json"),
      JSON.stringify({ orgSlug: "o" }),
    );
    expect(await readState(cwd)).toBeNull();
  });
});

describe("clearStaleProjectState", () => {
  it("removes state.json scoped to a different org and reports the removal", async () => {
    await writeState(
      { orgSlug: "anon-old", projectSlug: "proj", projectId: "pid-old" },
      cwd,
    );
    const removed = await clearStaleProjectState("anon-new", cwd);
    expect(removed).toBe(true);
    expect(await readState(cwd)).toBeNull();
  });

  it("keeps state.json that already belongs to the current org", async () => {
    const state = {
      orgSlug: "anon-same",
      projectSlug: "proj",
      projectId: "pid-1",
    };
    await writeState(state, cwd);
    const removed = await clearStaleProjectState("anon-same", cwd);
    expect(removed).toBe(false);
    expect(await readState(cwd)).toEqual(state);
  });

  it("is a no-op when there is no state.json", async () => {
    const removed = await clearStaleProjectState("anon-any", cwd);
    expect(removed).toBe(false);
    expect(await readState(cwd)).toBeNull();
  });

  it("treats a malformed state.json as absent (readState returns null) and leaves it", async () => {
    // readState returns null for unreadable/invalid files, so there is no
    // org to compare against; clearing here would be an over-reach that
    // discards a file the user may be repairing by hand.
    mkdirSync(join(cwd, ".arkor"), { recursive: true });
    writeFileSync(join(cwd, ".arkor", "state.json"), "{not json");
    const removed = await clearStaleProjectState("anon-any", cwd);
    expect(removed).toBe(false);
  });
});
