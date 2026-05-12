import { describe, expect, it } from "vitest";
import { computeDisplayStatus } from "./jobStatus";

describe("computeDisplayStatus", () => {
  it("returns the SSE terminal status when present", () => {
    expect(
      computeDisplayStatus({
        job: { status: "running" },
        liveStatus: "running",
        terminalStatus: "completed",
      }),
    ).toBe("completed");
    expect(
      computeDisplayStatus({
        job: { status: "running" },
        liveStatus: "running",
        terminalStatus: "failed",
      }),
    ).toBe("failed");
  });

  it("preempts liveStatus when polled status is already terminal", () => {
    expect(
      computeDisplayStatus({
        job: { status: "completed" },
        liveStatus: "running",
      }),
    ).toBe("completed");
    expect(
      computeDisplayStatus({
        job: { status: "cancelled" },
        liveStatus: "running",
      }),
    ).toBe("cancelled");
  });

  it("flips to running when SSE training.started is seen", () => {
    expect(
      computeDisplayStatus({
        job: { status: "queued" },
        liveStatus: "running",
        eventStreamConnected: true,
      }),
    ).toBe("running");
  });

  it("returns provisioning while queued and the event stream is open", () => {
    expect(
      computeDisplayStatus({
        job: { status: "queued" },
        eventStreamConnected: true,
      }),
    ).toBe("provisioning");
  });

  it("returns provisioning while queued and createdAt is recent", () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0);
    const created = new Date(now - 30_000).toISOString();
    expect(
      computeDisplayStatus({
        job: { status: "queued", createdAt: created },
        now,
      }),
    ).toBe("provisioning");
  });

  it("returns queued when not connected and createdAt is past the recent window", () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0);
    const created = new Date(now - 5 * 60_000).toISOString();
    expect(
      computeDisplayStatus({
        job: { status: "queued", createdAt: created },
        now,
      }),
    ).toBe("queued");
  });

  it("treats job = null as queued (no createdAt to anchor)", () => {
    expect(computeDisplayStatus({ job: null })).toBe("queued");
  });

  it("treats job = null as provisioning when the event stream is open", () => {
    expect(
      computeDisplayStatus({ job: null, eventStreamConnected: true }),
    ).toBe("provisioning");
  });

  it("respects a custom recentMs window", () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0);
    const created = new Date(now - 30_000).toISOString();
    expect(
      computeDisplayStatus({
        job: { status: "queued", createdAt: created },
        now,
        recentMs: 10_000,
      }),
    ).toBe("queued");
  });

  it("falls through to polled non-terminal status when no live signals", () => {
    expect(
      computeDisplayStatus({
        job: { status: "running" },
      }),
    ).toBe("running");
  });

  it("ignores invalid createdAt", () => {
    expect(
      computeDisplayStatus({
        job: { status: "queued", createdAt: "not-a-date" },
        now: Date.now(),
      }),
    ).toBe("queued");
  });
});
