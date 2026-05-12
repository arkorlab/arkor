import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_MODEL, SUPPORTED_BASE_MODELS } from "./baseModels";

describe("baseModels", () => {
  it("DEFAULT_BASE_MODEL is the first entry in SUPPORTED_BASE_MODELS", () => {
    // The Playground picks DEFAULT_BASE_MODEL at startup. If a future
    // refactor reorders the list without updating the default, the
    // selected option in the UI would silently drift.
    expect(DEFAULT_BASE_MODEL).toBe(SUPPORTED_BASE_MODELS[0]);
  });

  it("SUPPORTED_BASE_MODELS contains at least one entry", () => {
    // Cloud-api accepts a closed set of base models on /v1/inference/chat;
    // shipping the SPA with an empty list would mean no Playground option
    // could ever be selected. Guard against the regression.
    expect(SUPPORTED_BASE_MODELS.length).toBeGreaterThan(0);
  });

  it("every entry is a non-empty model id matching HF identifier shape", () => {
    // Cloud-api originally accepted lowercase ids only; it now normalises
    // case internally and keeps a separate display name, so uppercase
    // segments from the upstream HF id (e.g. `unsloth/gemma-4-E4B-it`)
    // are accepted. The regex allows that shape while still rejecting
    // empty or otherwise malformed entries.
    for (const m of SUPPORTED_BASE_MODELS) {
      expect(m).toMatch(/^[A-Za-z0-9][A-Za-z0-9./_-]*$/);
    }
  });
});
