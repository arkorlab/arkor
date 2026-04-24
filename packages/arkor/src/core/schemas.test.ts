import { describe, it, expect } from "vitest";
import {
  jobStatusSchema,
  trainingJobSchema,
  anonymousTokenResponseSchema,
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
