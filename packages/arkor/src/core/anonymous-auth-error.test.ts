import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ACCOUNT_NOT_FOUND,
  ANONYMOUS_TOKEN_SINGLE_DEVICE,
  formatAnonymousAuthError,
  isAnonymousAuthDeadEnd,
} from "./anonymous-auth-error";
import { CloudApiError } from "./client";

describe("formatAnonymousAuthError", () => {
  it("returns null for non-CloudApiError values", () => {
    expect(formatAnonymousAuthError(new Error("boom"))).toBeNull();
    expect(formatAnonymousAuthError("string")).toBeNull();
    expect(formatAnonymousAuthError(undefined)).toBeNull();
  });

  it("returns null for CloudApiError without a known code", () => {
    expect(formatAnonymousAuthError(new CloudApiError(500, "boom"))).toBeNull();
    expect(
      formatAnonymousAuthError(new CloudApiError(401, "Unauthorized")),
    ).toBeNull();
    expect(
      formatAnonymousAuthError(
        new CloudApiError(400, "validation", "some_other_code"),
      ),
    ).toBeNull();
  });

  it("formats anonymous_token_single_device with multi-device guidance", () => {
    const out = formatAnonymousAuthError(
      new CloudApiError(409, "...", ANONYMOUS_TOKEN_SINGLE_DEVICE),
    );
    expect(out).not.toBeNull();
    expect(out!).toMatch(/single-device/);
    // Must direct at the OAuth flow specifically, not the bare `arkor
    // login` (whose interactive picker defaults to Anonymous and would
    // just re-issue another single-device token).
    expect(out!).toMatch(/arkor login --oauth/);
  });

  it("formats anonymous_account_not_found with re-login guidance", () => {
    const out = formatAnonymousAuthError(
      new CloudApiError(401, "...", ANONYMOUS_ACCOUNT_NOT_FOUND),
    );
    expect(out).not.toBeNull();
    expect(out!).toMatch(/no longer valid/);
    expect(out!).toMatch(/arkor login --oauth/);
  });
});

describe("isAnonymousAuthDeadEnd", () => {
  it("identifies the two known auth-state codes", () => {
    expect(
      isAnonymousAuthDeadEnd(
        new CloudApiError(409, "x", ANONYMOUS_TOKEN_SINGLE_DEVICE),
      ),
    ).toBe(true);
    expect(
      isAnonymousAuthDeadEnd(
        new CloudApiError(401, "x", ANONYMOUS_ACCOUNT_NOT_FOUND),
      ),
    ).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isAnonymousAuthDeadEnd(new Error("x"))).toBe(false);
    expect(isAnonymousAuthDeadEnd(new CloudApiError(500, "x"))).toBe(false);
    expect(
      isAnonymousAuthDeadEnd(new CloudApiError(401, "x", "other_code")),
    ).toBe(false);
  });
});
