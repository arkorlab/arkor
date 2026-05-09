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

  it("every entry is a non-empty HuggingFace-style model id", () => {
    // The cloud-api validation is case-sensitive (the canonical
    // HuggingFace id is itself mixed-case, e.g. `unsloth/gemma-4-E4B-it`),
    // so the entries must round-trip without case-folding. Allow A-Z /
    // a-z / digits / `./_-` and require a non-empty leading char so an
    // accidentally-empty entry trips the guard.
    for (const m of SUPPORTED_BASE_MODELS) {
      expect(m).toMatch(/^[A-Za-z0-9][A-Za-z0-9./_-]*$/);
    }
  });
});
