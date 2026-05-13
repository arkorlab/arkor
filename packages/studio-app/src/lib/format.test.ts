import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatRelativeTime,
  truncateMiddle,
} from "./format";

describe("formatDuration", () => {
  it("returns em-dash for invalid input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
  });

  it("renders sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("renders sub-hour durations as Xm Ys with zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(75_000)).toBe("1m 15s");
    expect(formatDuration(59 * 60_000 + 9_000)).toBe("59m 09s");
  });

  it("renders hour-plus durations as Xh YYm ZZs", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m 00s");
    expect(formatDuration(3_605_000)).toBe("1h 00m 05s");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000 + 7_000)).toBe(
      "2h 05m 07s",
    );
  });
});

describe("formatRelativeTime", () => {
  // Pin "now" so the test is reproducible regardless of when it runs.
  const NOW = Date.parse("2026-05-02T12:00:00.000Z");

  it("returns em-dash for unparseable input", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("—");
  });

  it("formats past timestamps with 'ago' phrasing", () => {
    // 30 seconds ago → seconds bucket
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toMatch(
      /\b30 seconds ago\b/,
    );
    // 5 minutes ago → minutes bucket
    expect(
      formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW),
    ).toMatch(/\b5 minutes ago\b/);
    // 3 hours ago → hours bucket
    expect(
      formatRelativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW),
    ).toMatch(/\b3 hours ago\b/);
    // 2 days ago → days bucket
    expect(
      formatRelativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW),
    ).toMatch(/\b2 days ago\b/);
  });

  it("formats future timestamps with 'in' phrasing", () => {
    expect(
      formatRelativeTime(new Date(NOW + 5 * 60_000).toISOString(), NOW),
    ).toMatch(/\bin 5 minutes\b/);
  });

  it("crosses the 45-second / 45-minute boundaries cleanly", () => {
    // < 45s falls into the seconds bucket
    const just44 = formatRelativeTime(
      new Date(NOW - 44_000).toISOString(),
      NOW,
    );
    expect(just44).toMatch(/seconds|second/);
    // ≥ 45s rounds up into minutes via Math.round
    const just45 = formatRelativeTime(
      new Date(NOW - 45_000).toISOString(),
      NOW,
    );
    expect(just45).toMatch(/minute/);
  });
});

describe("truncateMiddle", () => {
  it("returns the original string when it's already short enough", () => {
    expect(truncateMiddle("short", 6, 4)).toBe("short");
    expect(truncateMiddle("01234567890", 6, 4)).toBe("01234567890");
  });

  it("inserts a single ellipsis with the requested head/tail counts", () => {
    expect(truncateMiddle("0123456789abcdef", 6, 4)).toBe("012345…cdef");
    expect(truncateMiddle("0123456789abcdef", 4, 4)).toBe("0123…cdef");
  });

  it("uses 6/4 defaults when counts are omitted", () => {
    expect(truncateMiddle("0123456789abcdef")).toBe("012345…cdef");
  });
});
