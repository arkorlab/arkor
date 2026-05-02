import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecordedDeprecation,
  getRecordedDeprecation,
  recordDeprecation,
  tapDeprecation,
} from "./deprecation";

afterEach(() => {
  // Module-level state persists across tests; reset to the production
  // baseline (`null`) so assertions on `getRecordedDeprecation()`
  // aren't order-dependent and a leftover sentinel can't leak into
  // other test files in the same vitest worker.
  clearRecordedDeprecation();
});

describe("recordDeprecation / getRecordedDeprecation", () => {
  it("round-trips the recorded notice", () => {
    recordDeprecation({
      sdkVersion: "1.2.3",
      message: "deprecated",
      sunset: "Wed, 01 Jul 2026 00:00:00 GMT",
    });
    expect(getRecordedDeprecation()).toEqual({
      sdkVersion: "1.2.3",
      message: "deprecated",
      sunset: "Wed, 01 Jul 2026 00:00:00 GMT",
    });
  });

  it("is latest-wins across multiple records", () => {
    recordDeprecation({ sdkVersion: "1.0.0", message: "first", sunset: null });
    recordDeprecation({ sdkVersion: "1.1.0", message: "second", sunset: null });
    expect(getRecordedDeprecation()?.message).toBe("second");
    expect(getRecordedDeprecation()?.sdkVersion).toBe("1.1.0");
  });
});

describe("tapDeprecation", () => {
  it("does nothing when the Deprecation header is absent", () => {
    recordDeprecation({
      sdkVersion: "baseline",
      message: "baseline",
      sunset: null,
    });
    const res = new Response(null, { status: 200 });
    tapDeprecation(res, "1.4.0");
    // Untouched — still the baseline we just wrote.
    expect(getRecordedDeprecation()?.sdkVersion).toBe("baseline");
  });

  it("does nothing when Deprecation is set to a value other than 'true'", () => {
    recordDeprecation({
      sdkVersion: "baseline",
      message: "baseline",
      sunset: null,
    });
    const res = new Response(null, {
      status: 200,
      headers: { Deprecation: "false" },
    });
    tapDeprecation(res, "1.4.0");
    expect(getRecordedDeprecation()?.sdkVersion).toBe("baseline");
  });

  it("extracts the message from RFC 7234 Warning header (299 - \"…\")", () => {
    const res = new Response(null, {
      status: 200,
      headers: {
        Deprecation: "true",
        Warning: '299 - "Arkor SDK 1.4.0 is deprecated; upgrade to 2.x"',
      },
    });
    tapDeprecation(res, "1.4.0");
    expect(getRecordedDeprecation()).toEqual({
      sdkVersion: "1.4.0",
      message: "Arkor SDK 1.4.0 is deprecated; upgrade to 2.x",
      sunset: null,
    });
  });

  it("captures the Sunset header verbatim when present", () => {
    const res = new Response(null, {
      status: 200,
      headers: {
        Deprecation: "true",
        Warning: '299 - "deprecated"',
        Sunset: "Wed, 01 Jul 2026 00:00:00 GMT",
      },
    });
    tapDeprecation(res, "1.4.0");
    expect(getRecordedDeprecation()?.sunset).toBe(
      "Wed, 01 Jul 2026 00:00:00 GMT",
    );
  });

  it("falls back to the raw Warning string when it does not match the RFC pattern", () => {
    const res = new Response(null, {
      status: 200,
      headers: {
        Deprecation: "true",
        // Missing the leading 3-digit code + dash → regex misses, raw used.
        Warning: "deprecated, please upgrade",
      },
    });
    tapDeprecation(res, "1.4.0");
    expect(getRecordedDeprecation()?.message).toBe("deprecated, please upgrade");
  });

  it("falls back to a generic message when Warning is missing entirely", () => {
    const res = new Response(null, {
      status: 200,
      headers: { Deprecation: "true" },
    });
    tapDeprecation(res, "1.4.0");
    expect(getRecordedDeprecation()?.message).toBe(
      "Arkor SDK 1.4.0 is deprecated",
    );
  });
});
