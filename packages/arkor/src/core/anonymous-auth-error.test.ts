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

  describe("anonymous_token_single_device", () => {
    it("recommends `arkor login --oauth` when OAuth is confirmed available", () => {
      const out = formatAnonymousAuthError(
        new CloudApiError(409, "...", ANONYMOUS_TOKEN_SINGLE_DEVICE),
        { oauthAvailable: true },
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/single-device/);
      // Must direct at the OAuth flow specifically — `arkor login`
      // alone would launch an interactive picker that defaults to
      // Anonymous and would just re-issue another single-device token.
      expect(out!).toMatch(/arkor login --oauth/);
    });

    it("falls back to `arkor login --anonymous` when OAuth is not available", () => {
      // Anon-only deployments don't have OAuth configured. Pointing
      // users at `--oauth` there would surface a command that fails
      // immediately, so the formatter recommends the only recovery
      // that always works (mint a new anon identity).
      const out = formatAnonymousAuthError(
        new CloudApiError(409, "...", ANONYMOUS_TOKEN_SINGLE_DEVICE),
        { oauthAvailable: false },
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/single-device/);
      expect(out!).toMatch(/arkor login --anonymous/);
      expect(out!).not.toMatch(/arkor login --oauth/);
    });

    it("hedges with both commands when probe is inconclusive (oauthAvailable === undefined)", () => {
      // An earlier version collapsed `undefined` into `false` (same
      // gating contract as ANON_PERSISTENCE_NUDGE), but on the
      // dead-end formatter path that hid the correct recovery
      // (`--oauth`) whenever the config probe just timed out. Now we
      // surface both commands and tell the user what to try first.
      const out = formatAnonymousAuthError(
        new CloudApiError(409, "...", ANONYMOUS_TOKEN_SINGLE_DEVICE),
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/single-device/);
      expect(out!).toMatch(/Couldn't reach the deployment/);
      expect(out!).toMatch(/arkor login --oauth/);
      expect(out!).toMatch(/arkor login --anonymous/);
      // The "OAuth is not configured" hedge must NOT claim that's
      // the current state. It only describes what to do if the user
      // hits that error.
      expect(out!).not.toMatch(/does not advertise OAuth/);
    });
  });

  describe("anonymous_account_not_found", () => {
    it("recommends `arkor login --oauth` when OAuth is confirmed available", () => {
      const out = formatAnonymousAuthError(
        new CloudApiError(401, "...", ANONYMOUS_ACCOUNT_NOT_FOUND),
        { oauthAvailable: true },
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/no longer valid/);
      expect(out!).toMatch(/arkor login --oauth/);
    });

    it("falls back to `arkor login --anonymous` when OAuth is not available", () => {
      const out = formatAnonymousAuthError(
        new CloudApiError(401, "...", ANONYMOUS_ACCOUNT_NOT_FOUND),
        { oauthAvailable: false },
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/no longer valid/);
      expect(out!).toMatch(/arkor login --anonymous/);
      expect(out!).not.toMatch(/arkor login --oauth/);
    });

    it("hedges with both commands when probe is inconclusive (oauthAvailable === undefined)", () => {
      const out = formatAnonymousAuthError(
        new CloudApiError(401, "...", ANONYMOUS_ACCOUNT_NOT_FOUND),
      );
      expect(out).not.toBeNull();
      expect(out!).toMatch(/no longer valid/);
      expect(out!).toMatch(/Couldn't reach the deployment/);
      expect(out!).toMatch(/arkor login --oauth/);
      expect(out!).toMatch(/arkor login --anonymous/);
    });
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
