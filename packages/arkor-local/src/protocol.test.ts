import { describe, expect, it } from "vitest";

import { PROTOCOL_MARKER, parseProtocolLine, toStreamEvent } from "./protocol";

function line(payload: unknown): string {
  return `${PROTOCOL_MARKER}${JSON.stringify(payload)}`;
}

describe("parseProtocolLine", () => {
  it("classifies unmarked lines as console output", () => {
    expect(parseProtocolLine("Fetching 12 files: 100%")).toEqual({
      kind: "console",
    });
    expect(parseProtocolLine("")).toEqual({ kind: "console" });
    // JSON without the marker is still console output: only the marker
    // promotes a line into the protocol.
    expect(parseProtocolLine('{"type":"started"}')).toEqual({
      kind: "console",
    });
    // The marker only counts at the start of the line: a trainer merely
    // MENTIONING it mid-line (e.g. tqdm output quoting a log line) must not
    // be promoted into the protocol.
    expect(parseProtocolLine('prefix @arkor {"type":"started"}')).toEqual({
      kind: "console",
    });
  });

  it("parses every event type", () => {
    expect(parseProtocolLine(line({ type: "started" }))).toEqual({
      kind: "event",
      event: { type: "started" },
    });
    const log = parseProtocolLine(
      line({ type: "log", step: 10, loss: 2.5, learningRate: 1e-5 }),
    );
    expect(log).toMatchObject({
      kind: "event",
      event: { type: "log", step: 10, loss: 2.5, learningRate: 1e-5 },
    });
    expect(
      parseProtocolLine(
        line({ type: "checkpoint", step: 50, adapterDir: "/a" }),
      ),
    ).toEqual({
      kind: "event",
      event: { type: "checkpoint", step: 50, adapterDir: "/a" },
    });
    expect(
      parseProtocolLine(line({ type: "completed", adapterDir: "/a/final" })),
    ).toMatchObject({
      kind: "event",
      event: { type: "completed", adapterDir: "/a/final" },
    });
    expect(
      parseProtocolLine(line({ type: "failed", error: "boom", step: 3 })),
    ).toEqual({
      kind: "event",
      event: { type: "failed", error: "boom", step: 3 },
    });
  });

  it("normalises absent metric fields to null", () => {
    const parsed = parseProtocolLine(line({ type: "log", step: 1 }));
    expect(parsed).toEqual({
      kind: "event",
      event: {
        type: "log",
        step: 1,
        loss: null,
        evalLoss: null,
        learningRate: null,
        epoch: null,
        samplesPerSecond: null,
      },
    });
  });

  it("reports marked lines with broken JSON as invalid, never throws", () => {
    const parsed = parseProtocolLine(`${PROTOCOL_MARKER}{"type": "log",`);
    expect(parsed.kind).toBe("invalid");
  });

  it("reports marked lines failing validation as invalid", () => {
    // A shim bug (or a library that happens to print the marker) must not
    // crash the runner mid-training.
    expect(parseProtocolLine(line({ type: "log" })).kind).toBe("invalid");
    expect(parseProtocolLine(line({ type: "unknown-event" })).kind).toBe(
      "invalid",
    );
    expect(parseProtocolLine(line("just a string")).kind).toBe("invalid");
  });
});

describe("toStreamEvent", () => {
  const TS = "2026-01-01T00:00:00Z";

  it("maps started", () => {
    expect(toStreamEvent({ type: "started" }, "j1", TS)).toEqual({
      type: "training.started",
      jobId: "j1",
      timestamp: TS,
    });
  });

  it("maps log with all metrics", () => {
    expect(
      toStreamEvent(
        {
          type: "log",
          step: 5,
          loss: 1.5,
          evalLoss: null,
          learningRate: 2e-5,
          epoch: 0.5,
          samplesPerSecond: 3.2,
        },
        "j1",
        TS,
      ),
    ).toEqual({
      type: "training.log",
      jobId: "j1",
      timestamp: TS,
      step: 5,
      loss: 1.5,
      evalLoss: null,
      learningRate: 2e-5,
      epoch: 0.5,
      samplesPerSecond: 3.2,
    });
  });

  it("maps checkpoint to checkpoint.saved with a local-adapter artifact", () => {
    expect(
      toStreamEvent(
        {
          type: "checkpoint",
          step: 50,
          adapterDir: "/jobs/j1/adapters/step-50",
        },
        "j1",
        TS,
      ),
    ).toEqual({
      type: "checkpoint.saved",
      jobId: "j1",
      timestamp: TS,
      step: 50,
      artifacts: [{ type: "local-adapter", path: "/jobs/j1/adapters/step-50" }],
    });
  });

  it("maps completed with and without an adapter dir", () => {
    expect(
      toStreamEvent(
        {
          type: "completed",
          adapterDir: "/jobs/j1/adapters/final",
          metrics: { finalLoss: 1.2 },
        },
        "j1",
        TS,
      ),
    ).toEqual({
      type: "training.completed",
      jobId: "j1",
      timestamp: TS,
      metrics: { finalLoss: 1.2 },
      artifacts: [{ type: "local-adapter", path: "/jobs/j1/adapters/final" }],
    });
    // Dry runs finish without producing an adapter.
    expect(
      toStreamEvent({ type: "completed", adapterDir: null }, "j1", TS),
    ).toEqual({
      type: "training.completed",
      jobId: "j1",
      timestamp: TS,
      artifacts: [],
    });
  });

  it("maps failed", () => {
    expect(
      toStreamEvent({ type: "failed", error: "OOM", step: 12 }, "j1", TS),
    ).toEqual({
      type: "training.failed",
      jobId: "j1",
      timestamp: TS,
      error: "OOM",
      step: 12,
    });
  });
});
