// @vitest-environment jsdom
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

function renderComposer(props?: { value?: string; disabled?: boolean }) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  render(
    <Composer
      value={props?.value ?? "hello"}
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={props?.disabled}
    />,
  );
  const textarea = screen.getByRole("textbox", { name: "Message" });
  return { onSubmit, onChange, textarea };
}

describe("Composer Enter handling", () => {
  it("submits on a plain Enter", () => {
    const { onSubmit, textarea } = renderComposer();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("inserts a newline (does not submit) on Shift+Enter", () => {
    const { onSubmit, textarea } = renderComposer();
    // jsdom does not perform the textarea newline edit for a synthetic keydown,
    // so assert the handler leaves the default action intact (no preventDefault).
    // Calling preventDefault would suppress the browser's native newline insert.
    const event = createEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: true,
    });
    fireEvent(textarea, event);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while an IME composition is active (isComposing)", () => {
    const { onSubmit, textarea } = renderComposer();
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Regression: in Safari `compositionend` fires before `keydown`, so the Enter
  // that commits an IME conversion has `isComposing === false` but `keyCode === 229`.
  it("does not submit on the Enter that commits an IME conversion (keyCode 229)", () => {
    const { onSubmit, textarea } = renderComposer();
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when the value is only whitespace", () => {
    const { onSubmit, textarea } = renderComposer({ value: "   " });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when disabled", () => {
    const { onSubmit, textarea } = renderComposer({ disabled: true });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
