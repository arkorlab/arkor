import { describe, it, expect } from "vitest";
import {
  jobStatusSchema,
  trainingJobSchema,
  anonymousTokenResponseSchema,
  listDeploymentKeysResponseSchema,
} from "./schemas";

describe("jobStatusSchema", () => {
  it("accepts all known statuses", () => {
    for (const s of ["queued", "running", "completed", "failed", "cancelled"] as const) {
      expect(jobStatusSchema.parse(s)).toBe(s);
    }
  });
  it("rejects unknown statuses", () => {
    expect(() => jobStatusSchema.parse("loitering")).toThrow();
  });
});

describe("trainingJobSchema", () => {
  const valid = {
    id: "j1",
    orgId: "o1",
    projectId: "p1",
    name: "run",
    status: "queued",
    config: { model: "unsloth/gemma-4-E4B-it" },
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
  };

  it("accepts the minimum shape", () => {
    const parsed = trainingJobSchema.parse(valid);
    expect(parsed.status).toBe("queued");
  });

  it("normalises Date timestamps to strings", () => {
    const parsed = trainingJobSchema.parse({
      ...valid,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(typeof parsed.createdAt).toBe("string");
  });

  it("allows extra fields (looseObject)", () => {
    const parsed = trainingJobSchema.parse({
      ...valid,
      provider: "runpod",
      providerJobId: "rp-1",
    });
    expect(parsed.id).toBe("j1");
  });

  it("rejects missing required fields", () => {
    const { id: _omit, ...rest } = valid;
    expect(() => trainingJobSchema.parse(rest)).toThrow();
  });

  it("normalises non-null startedAt/completedAt strings via the truthy branch", () => {
    // Branch coverage for the `v ? String(v) : null` transforms — the
    // `null` branch is exercised by every other test in this file
    // (the `valid` fixture has both fields null), but the `String(v)`
    // branch only fires when the field carries an actual timestamp.
    const parsed = trainingJobSchema.parse({
      ...valid,
      startedAt: "2026-01-01T00:00:01Z",
      completedAt: new Date("2026-01-01T00:00:02Z"),
    });
    expect(typeof parsed.startedAt).toBe("string");
    expect(parsed.startedAt).toBe("2026-01-01T00:00:01Z");
    expect(typeof parsed.completedAt).toBe("string");
  });
});

describe("anonymousTokenResponseSchema", () => {
  it("requires token + personalOrg shape", () => {
    expect(() =>
      anonymousTokenResponseSchema.parse({
        token: "t",
        anonymousId: "a",
        kind: "cli",
        personalOrg: { id: "o", slug: "anon-a", name: "Anon" },
      }),
    ).not.toThrow();

    expect(() =>
      anonymousTokenResponseSchema.parse({
        token: "t",
        anonymousId: "a",
        kind: "cli",
        personalOrg: { slug: "anon-a" },
      }),
    ).toThrow();
  });
});

describe("listDeploymentKeysResponseSchema", () => {
  // The list-keys response is documented as the no-plaintext shape
  // (`DeploymentKeyDto` has no `plaintext` field). The parse step has
  // a defensive `.transform` that strips `plaintext` if a regressed
  // server ever included it — tested here so a future change to the
  // sanitiser can't silently leak raw API keys to SDK callers.
  const minimalKey = {
    id: "k1",
    label: "production",
    prefix: "ark_live_",
    enabled: true,
    createdAt: "2026-05-04T00:00:00Z",
    lastUsedAt: null,
  };

  it("accepts the documented no-plaintext shape", () => {
    const parsed = listDeploymentKeysResponseSchema.parse({
      keys: [minimalKey],
    });
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.id).toBe("k1");
  });

  it("strips an unexpected `plaintext` field from a list entry", () => {
    // Regression guard: if the control plane ever (incorrectly) returns
    // a plaintext key on the list response, the SDK's `.transform`
    // must drop it before it reaches the caller. The exported
    // `DeploymentKeyDto` type has no `plaintext`, so leaking it would
    // both violate the type contract and expose the raw secret.
    const parsed = listDeploymentKeysResponseSchema.parse({
      keys: [
        {
          ...minimalKey,
          plaintext: "ark_live_LEAKED_SECRET",
        },
      ],
    });
    expect(parsed.keys[0]).not.toHaveProperty("plaintext");
    // Stringifying the parsed payload — the form the SPA / SDK callers
    // would re-emit — must not contain the secret either.
    expect(JSON.stringify(parsed)).not.toContain("LEAKED_SECRET");
  });

  it("strips `plaintext` even when other unknown fields are present", () => {
    // The schema is intentionally `looseObject`, so future server-side
    // additions (e.g. a new metadata field) flow through untouched.
    // The strip targets `plaintext` specifically — make sure it
    // doesn't drop unrelated unknown keys as collateral damage.
    const parsed = listDeploymentKeysResponseSchema.parse({
      keys: [
        {
          ...minimalKey,
          plaintext: "ark_live_LEAKED",
          someFutureField: "preserved",
        },
      ],
    });
    expect(parsed.keys[0]).not.toHaveProperty("plaintext");
    expect((parsed.keys[0] as Record<string, unknown>).someFutureField).toBe(
      "preserved",
    );
  });
});
