import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mock for @clack/prompts. Vitest hoists `vi.mock` so the
// module factory runs before `import "./prompts"` resolves the mocked
// surface. Each test below grabs the mocked exports via `vi.mocked(clack.X)`
// and rebinds the implementation per case.
vi.mock("@clack/prompts", () => {
  const cancelSym = Symbol.for("clack:cancel");
  return {
    text: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    isCancel: vi.fn((v: unknown) => v === cancelSym),
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spinner: vi.fn(),
  };
});

import * as clack from "@clack/prompts";
import {
  CliCancelled,
  isInteractive,
  promptConfirm,
  promptSelect,
  promptText,
} from "./prompts";

const CLACK_CANCEL = Symbol.for("clack:cancel");

const ORIG_CI = process.env.CI;
const ORIG_TTY = process.stdout.isTTY;

beforeEach(() => {
  // Default to non-interactive: CI set OR no TTY. Individual tests can flip
  // the toggle.
  process.env.CI = "1";
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  if (ORIG_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIG_CI;
  Object.defineProperty(process.stdout, "isTTY", {
    value: ORIG_TTY,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("isInteractive", () => {
  it("returns false when CI is set even if stdout is a TTY", () => {
    process.env.CI = "1";
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    expect(isInteractive()).toBe(false);
  });

  it("returns false when stdout is not a TTY", () => {
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(isInteractive()).toBe(false);
  });

  it("returns true when stdout is a TTY and CI is unset", () => {
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    expect(isInteractive()).toBe(true);
  });
});

describe("promptText", () => {
  it("returns skipWith without prompting", async () => {
    const v = await promptText({
      message: "Project name?",
      skipWith: "explicit-name",
    });
    expect(v).toBe("explicit-name");
  });

  it("returns initialValue in non-interactive mode when skipWith is unset", async () => {
    const v = await promptText({
      message: "Project name?",
      initialValue: "default-name",
    });
    expect(v).toBe("default-name");
  });

  it("throws in non-interactive mode when no skipWith and no initialValue", async () => {
    await expect(
      promptText({ message: "Project name?" }),
    ).rejects.toThrow(/non-interactive/);
  });

  it("returns the empty string when skipWith is empty", async () => {
    // Empty string is a valid (intentional) answer; only `undefined` should
    // trigger the prompt. Without `!== undefined` this would otherwise fall
    // through to the prompt path.
    const v = await promptText({
      message: "Optional note?",
      skipWith: "",
    });
    expect(v).toBe("");
  });
});

describe("promptSelect", () => {
  it("returns skipWith without prompting", async () => {
    const v = await promptSelect<"a" | "b">({
      message: "pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      skipWith: "b",
    });
    expect(v).toBe("b");
  });

  it("returns initialValue in non-interactive mode", async () => {
    const v = await promptSelect<"a" | "b">({
      message: "pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      initialValue: "a",
    });
    expect(v).toBe("a");
  });

  it("throws in non-interactive mode without skipWith or initialValue", async () => {
    await expect(
      promptSelect({
        message: "pick",
        options: [{ value: "x" as const, label: "X" }],
      }),
    ).rejects.toThrow(/non-interactive/);
  });
});

describe("promptConfirm", () => {
  it("returns skipWith without prompting (true)", async () => {
    const v = await promptConfirm({ message: "ok?", skipWith: true });
    expect(v).toBe(true);
  });

  it("returns skipWith without prompting (false)", async () => {
    // Distinct from initialValue=false; skipWith pins the answer regardless
    // of TTY state.
    const v = await promptConfirm({ message: "ok?", skipWith: false });
    expect(v).toBe(false);
  });

  it("returns initialValue in non-interactive mode", async () => {
    const v = await promptConfirm({ message: "ok?", initialValue: true });
    expect(v).toBe(true);
  });

  it("throws in non-interactive mode without skipWith or initialValue", async () => {
    await expect(promptConfirm({ message: "ok?" })).rejects.toThrow(
      /non-interactive/,
    );
  });
});

describe("CliCancelled", () => {
  it("is an Error with the expected name", () => {
    const e = new CliCancelled();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CliCancelled");
    expect(e.message).toMatch(/cancelled/i);
  });
});

// Cover the interactive branches by faking a TTY + a module-level clack
// mock so the prompt functions don't actually open a TUI in vitest's
// worker.
describe("interactive paths (clack stubbed)", () => {
  beforeEach(() => {
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  it("promptText returns the value clack.text resolves with", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce("typed-by-user" as never);
    const v = await promptText({ message: "Project name?" });
    expect(clack.text).toHaveBeenCalledOnce();
    expect(v).toBe("typed-by-user");
  });

  it("promptText throws CliCancelled when clack signals cancellation", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce(CLACK_CANCEL as never);
    await expect(promptText({ message: "?" })).rejects.toThrow(CliCancelled);
  });

  it("promptSelect returns the selected option's value", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("b" as never);
    const v = await promptSelect<"a" | "b">({
      message: "pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    expect(clack.select).toHaveBeenCalledOnce();
    expect(v).toBe("b");
  });

  it("promptSelect propagates CliCancelled on user cancel", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(CLACK_CANCEL as never);
    await expect(
      promptSelect({
        message: "pick",
        options: [{ value: "x" as const, label: "X" }],
      }),
    ).rejects.toThrow(CliCancelled);
  });

  it("promptConfirm returns the boolean clack.confirm resolves with", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(true as never);
    const v = await promptConfirm({ message: "ok?" });
    expect(clack.confirm).toHaveBeenCalledOnce();
    expect(v).toBe(true);
  });

  it("promptConfirm propagates CliCancelled on user cancel", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(CLACK_CANCEL as never);
    await expect(promptConfirm({ message: "ok?" })).rejects.toThrow(
      CliCancelled,
    );
  });

  it("throws a 'no value received' error when clack resolves to undefined", async () => {
    // The narrowing helper rejects undefined separately from cancellation —
    // a safety net for clack returning `undefined` (which historically has
    // happened in clack's own bug fixes for non-TTY edge cases).
    vi.mocked(clack.text).mockResolvedValueOnce(undefined as never);
    await expect(promptText({ message: "?" })).rejects.toThrow(
      /No value received/,
    );
  });
});
