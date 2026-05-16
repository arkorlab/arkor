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

  it("stays linear on adversarial dash-heavy inputs (CodeQL hardening)", () => {
    // CodeQL's "polynomial regex on uncontrolled data" query flagged
    // the previous chain because `sanitise()` sits on the
    // `--name` / `[dir]` data flow from both CLI scaffolders. The
    // original `+`-quantified replaces were already linear in practice
    // (this isn't a real ReDoS regression test), but a 100k-character
    // pathological input is a cheap belt-and-
    // suspenders check that the rewritten chain remains linear, and
    // anchors the alert resolution so a future rewrite that
    // accidentally introduced an ambiguous quantifier would trip the
    // timeout instead of silently re-opening the CodeQL alert.
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

  it("does not leak a trailing dash when the 60-char cap cuts on a separator", () => {
    // PR #141 review (Copilot): the trim used to run before the cap,
    // so an input like 59 alphanumerics followed by `_b` ended up as
    // `aaa…a-` (60 chars, ends with `-`) because the cap landed on
    // the dash. The chain is now slice-then-trim, so the trailing
    // separator gets stripped after the cap and the slug satisfies
    // the documented contract.
    const input = `${"a".repeat(59)}_b`;
    const result = sanitise(input);
    expect(result.endsWith("-")).toBe(false);
    expect(result).toBe("a".repeat(59));
  });

  it("preserves digits and dashes", () => {
    expect(sanitise("v2-runner-01")).toBe("v2-runner-01");
  });
});
