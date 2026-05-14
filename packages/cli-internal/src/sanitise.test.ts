import { describe, it, expect } from "vitest";
import { sanitise } from "./sanitise";

describe("sanitise", () => {
  it("lowercases the input", () => {
    expect(sanitise("MyApp")).toBe("myapp");
  });

  it("replaces non `[a-z0-9]` runs with a single dash", () => {
    expect(sanitise("hello world")).toBe("hello-world");
    expect(sanitise("Hello! World")).toBe("hello-world");
    expect(sanitise("foo_bar.baz")).toBe("foo-bar-baz");
    // Adjacent runs of non-alphanumerics (including mixed `-` and
    // other punctuation) collapse to one dash in a single pass.
    // This matters for the ReDoS-safety contract documented in
    // `sanitise.ts`: the chain no longer relies on a separate `-+`
    // collapse step that walked the same characters twice.
    expect(sanitise("a---b")).toBe("a-b");
    expect(sanitise("a-_-b")).toBe("a-b");
  });

  it("collapses leading and trailing dashes after substitution", () => {
    expect(sanitise("@scope/pkg")).toBe("scope-pkg");
    expect(sanitise("---abc---")).toBe("abc");
  });

  it("terminates in linear time on adversarial dash-heavy inputs (ReDoS regression)", () => {
    // CodeQL flagged the previous regex chain as a polynomial-ReDoS
    // hotspot once `sanitise()` started receiving CLI-arg input from
    // the CLAUDECODE strict-mode check. The current chain consumes
    // each character at most a constant number of times, so even a
    // pathological input completes in well under the test's timeout.
    const adversarial = "-".repeat(100_000);
    const start = Date.now();
    expect(sanitise(adversarial)).toBe("arkor-project");
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("falls back to `arkor-project` when the result would be empty", () => {
    expect(sanitise("")).toBe("arkor-project");
    expect(sanitise("!!!")).toBe("arkor-project");
    expect(sanitise("---")).toBe("arkor-project");
  });

  it("caps the result at 60 characters", () => {
    const long = "a".repeat(120);
    expect(sanitise(long)).toBe("a".repeat(60));
  });

  it("preserves digits and dashes", () => {
    expect(sanitise("v2-runner-01")).toBe("v2-runner-01");
  });
});
