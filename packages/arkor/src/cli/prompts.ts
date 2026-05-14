import * as clack from "@clack/prompts";

/**
 * Thin wrapper around `@clack/prompts` that:
 *
 *  - Skips prompts (returning `skipWith`) when a flag already determined the
 *    answer, so every command supports non-interactive / CI use.
 *  - Treats non-TTY environments (CI, piped stdout) as non-interactive and
 *    falls back to `skipWith`; throws if no default is available.
 *  - Narrows the clack result type (which may be a Cancel symbol) to the
 *    concrete value and turns cancellation into a thrown error so callers can
 *    propagate it with clear messaging.
 */

export function isInteractive(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    !process.env.CI &&
    process.env.CLAUDECODE !== "1"
  );
}

class CliCancelled extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CliCancelled";
  }
}

function assertValue<T>(value: T | symbol, message: string): T {
  if (clack.isCancel(value)) throw new CliCancelled();
  if (value === undefined) throw new Error(message);
  return value as T;
}

export interface TextPromptOptions {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  /** If defined, skip the prompt entirely and return this value. */
  skipWith?: string;
}

export async function promptText(options: TextPromptOptions): Promise<string> {
  if (options.skipWith !== undefined) return options.skipWith;
  if (!isInteractive()) {
    if (options.initialValue !== undefined) return options.initialValue;
    throw new Error(
      `Missing "${options.message}" and the terminal is non-interactive.`,
    );
  }
  const res = await clack.text({
    message: options.message,
    initialValue: options.initialValue,
    placeholder: options.placeholder,
    validate: options.validate,
  });
  return assertValue(res, "No value received");
}

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectPromptOptions<T extends string> {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
  skipWith?: T;
}

export async function promptSelect<T extends string>(
  options: SelectPromptOptions<T>,
): Promise<T> {
  if (options.skipWith !== undefined) return options.skipWith;
  if (!isInteractive()) {
    if (options.initialValue !== undefined) return options.initialValue;
    throw new Error(
      `Missing "${options.message}" selection and the terminal is non-interactive.`,
    );
  }
  // clack's Option<Value extends Primitive> makes `label` optional, which is
  // structurally compatible with ours but confuses TS's generic inference.
  // Cast at the boundary since our SelectOption is a strict subtype.
  const res = await clack.select<T>({
    message: options.message,
    options: options.options as unknown as Parameters<typeof clack.select<T>>[0]["options"],
    initialValue: options.initialValue,
  });
  return assertValue(res, "No option selected");
}

export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
  skipWith?: boolean;
}

export async function promptConfirm(
  options: ConfirmPromptOptions,
): Promise<boolean> {
  if (options.skipWith !== undefined) return options.skipWith;
  if (!isInteractive()) {
    if (options.initialValue !== undefined) return options.initialValue;
    throw new Error(
      `Missing confirmation for "${options.message}" and the terminal is non-interactive.`,
    );
  }
  const res = await clack.confirm({
    message: options.message,
    initialValue: options.initialValue,
  });
  return assertValue(res, "No confirmation received");
}

export const ui = {
  intro: clack.intro,
  outro: clack.outro,
  note: clack.note,
  log: clack.log,
  spinner: clack.spinner,
  isCancel: clack.isCancel,
};

export { CliCancelled };
