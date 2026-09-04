import { describe, expect, it } from "vitest";

import {
  LOCAL_SCOPE,
  LOCAL_SERVER_TOKEN_ENV,
  LOCAL_SERVER_URL_ENV,
  localCredentials,
  readLocalMode,
} from "./local-mode";

describe("readLocalMode", () => {
  it("returns null when neither variable is set", () => {
    expect(readLocalMode({})).toBeNull();
  });

  it("returns the hand-off when both variables are set", () => {
    const mode = readLocalMode({
      [LOCAL_SERVER_URL_ENV]: "http://127.0.0.1:34567",
      [LOCAL_SERVER_TOKEN_ENV]: "token-1234567890abcdef",
    });
    expect(mode).toEqual({
      baseUrl: "http://127.0.0.1:34567",
      token: "token-1234567890abcdef",
    });
  });

  it("throws when only the URL is set", () => {
    // A half-set hand-off means someone exported one variable by hand;
    // proceeding would send unauthenticated requests to the local server.
    expect(() =>
      readLocalMode({ [LOCAL_SERVER_URL_ENV]: "http://127.0.0.1:34567" }),
    ).toThrow(/must be set together/);
  });

  it("throws when only the token is set", () => {
    // The inverse half: a dummy identity would silently target the cloud.
    expect(() =>
      readLocalMode({ [LOCAL_SERVER_TOKEN_ENV]: "token-1234567890abcdef" }),
    ).toThrow(/must be set together/);
  });

  it("rejects a non-loopback URL", () => {
    // The bearer token rides on every request to this URL; a poisoned env
    // value must not exfiltrate it (or the job config) to another host.
    expect(() =>
      readLocalMode({
        [LOCAL_SERVER_URL_ENV]: "http://attacker.example:34567",
        [LOCAL_SERVER_TOKEN_ENV]: "token-1234567890abcdef",
      }),
    ).toThrow(/http:\/\/127\.0\.0\.1/);
  });

  it("rejects everything but the exact shape the CLI writes", () => {
    // `localhost` can resolve to a non-loopback address via /etc/hosts and
    // the local server never binds IPv6, so only http://127.0.0.1:<port>
    // (what startLocalServer produces) passes.
    for (const bad of [
      "https://127.0.0.1:34567",
      "http://localhost:4001",
      "http://[::1]:4001",
      "http://127.0.0.1",
      "http://127.0.0.1:4001/path",
      "http://127.0.0.1:4001/?q=1",
      "http://127.0.0.1:4001/#frag",
      "http://user:pass@127.0.0.1:4001",
      "not a url",
      "file:///x",
    ]) {
      expect(() =>
        readLocalMode({
          [LOCAL_SERVER_URL_ENV]: bad,
          [LOCAL_SERVER_TOKEN_ENV]: "token-1234567890abcdef",
        }),
      ).toThrow(/http:\/\/127\.0\.0\.1/);
    }
  });

  it("treats empty strings as unset", () => {
    // Shells commonly export empties when clearing variables; an empty URL
    // or token can never form a working hand-off, so both count as off.
    expect(
      readLocalMode({
        [LOCAL_SERVER_URL_ENV]: "",
        [LOCAL_SERVER_TOKEN_ENV]: "",
      }),
    ).toBeNull();
  });
});

describe("localCredentials", () => {
  it("builds in-memory anonymous-shaped credentials", () => {
    const credentials = localCredentials({
      baseUrl: "http://127.0.0.1:34567",
      token: "token-1234567890abcdef",
    });
    expect(credentials).toEqual({
      mode: "anon",
      token: "token-1234567890abcdef",
      anonymousId: "local",
      arkorCloudApiUrl: "http://127.0.0.1:34567",
      orgSlug: LOCAL_SCOPE.orgSlug,
    });
  });
});

describe("LOCAL_SCOPE", () => {
  it("is frozen", () => {
    // Shared across every local trainer and Studio proxy call; a mutation in
    // one call site must not leak into the others.
    expect(Object.isFrozen(LOCAL_SCOPE)).toBe(true);
  });
});
