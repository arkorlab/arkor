import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { readState, writeState, statePath } from "./state";

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

  it("round-trips the anonymousId owner marker when present", async () => {
    const state = {
      orgSlug: "anon-abc",
      projectSlug: "proj",
      projectId: "pid-1",
      anonymousId: "abc",
    };
    await writeState(state, cwd);
    expect(await readState(cwd)).toEqual(state);
  });

  it("omits anonymousId when it is absent or not a string", async () => {
    mkdirSync(join(cwd, ".arkor"), { recursive: true });
    // A non-string marker is dropped rather than propagated as garbage.
    writeFileSync(
      join(cwd, ".arkor", "state.json"),
      JSON.stringify({
        orgSlug: "o",
        projectSlug: "p",
        projectId: "pid",
        anonymousId: 123,
      }),
    );
    const state = await readState(cwd);
    expect(state).toEqual({ orgSlug: "o", projectSlug: "p", projectId: "pid" });
    expect(state && "anonymousId" in state).toBe(false);
  });
});
