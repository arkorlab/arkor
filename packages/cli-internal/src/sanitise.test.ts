import { describe, it, expect } from "vitest";
import { sanitise } from "./sanitise";

describe("sanitise", () => {
  it("lowercases the input", () => {
    expect(sanitise("MyApp")).toBe("myapp");
  });

  it("replaces non `[a-z0-9-]` characters with dashes", () => {
    expect(sanitise("hello world")).toBe("hello-world");
    expect(sanitise("Hello! World")).toBe("hello-world");
    expect(sanitise("foo_bar.baz")).toBe("foo-bar-baz");
  });

  it("collapses leading and trailing dashes after substitution", () => {
    expect(sanitise("@scope/pkg")).toBe("scope-pkg");
    expect(sanitise("---abc---")).toBe("abc");
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
