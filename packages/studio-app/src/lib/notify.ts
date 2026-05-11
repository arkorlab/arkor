export interface NotifyJobTerminalInput {
  status: "completed" | "failed";
  jobName: string;
  jobId: string;
  artifacts?: number;
  error?: string;
}

export interface ToastEventDetail {
  status: "completed" | "failed";
  jobName: string;
  jobId: string;
  message: string;
}

const TOAST_EVENT = "arkor:toast";

const notifiedTerminals = new Set<string>();

type NotificationCtor = typeof globalThis.Notification | undefined;

function getNotificationCtor(): NotificationCtor {
  if (typeof globalThis === "undefined") return undefined;
  return (globalThis as { Notification?: NotificationCtor }).Notification;
}

/**
 * Ask for OS notification permission, but only when the current state is
 * `default` so we don't re-prompt users who already chose. Safe to call
 * from a user-gesture handler (the click on Run training). No-ops in
 * environments without the Notification API.
 */
export function ensurePermissionOnGesture(): void {
  const Ctor = getNotificationCtor();
  if (!Ctor) return;
  if (Ctor.permission !== "default") return;
  try {
    const result = Ctor.requestPermission();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<NotificationPermission>).catch(() => undefined);
    }
  } catch {
    // Synchronous throws happen on a few older browsers; fall through.
  }
}

function summaryFor(input: NotifyJobTerminalInput): string {
  if (input.status === "completed") {
    const n = input.artifacts ?? 0;
    return `${input.jobName} (${n} artifact${n === 1 ? "" : "s"})`;
  }
  return input.error
    ? `${input.jobName} failed: ${input.error}`
    : `${input.jobName} failed`;
}

// Match either of the prefixes we set so a second terminal event of a
// different kind (e.g. ✓ then ⚠) replaces the existing marker instead
// of stacking as "⚠ ✓ Arkor".
const TITLE_PREFIX_RE = /^[✓⚠] /;

function ensureTitlePrefix(prefix: string): void {
  if (typeof document === "undefined") return;
  const stripped = document.title.replace(TITLE_PREFIX_RE, "");
  document.title = `${prefix}${stripped}`;
}

function isTabFocused(): boolean {
  if (typeof document === "undefined") return false;
  // `visibilityState === "visible"` is necessary but not sufficient: a
  // tab that is the selected one in a browser window sitting behind
  // another app still reports `visible`, yet the user clearly cannot
  // see in-page toasts. Check `hasFocus()` whenever it is available.
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function") return document.hasFocus();
  return true;
}

/**
 * Emit a terminal-event notification through three layers:
 *
 *   1. Toast: always, via a `CustomEvent("arkor:toast")` that the
 *      ToastProvider listens for. Works regardless of focus / permission.
 *   2. Title prefix (`✓` / `⚠`): only when the tab is not focused.
 *      Cleared on the next route change by an effect in `App` that
 *      resets `document.title` whenever the route key changes.
 *   3. OS Notification: only when permission was granted AND the tab is
 *      not focused. Tagged with the jobId so a duplicate SSE frame won't
 *      buzz the user twice.
 *
 * Deduplicated by `${jobId}:${status}` so reconnect-driven re-deliveries
 * of `training.completed` (or polled status arriving after the SSE
 * terminal frame already triggered us) only notify once.
 */
export function notifyJobTerminal(input: NotifyJobTerminalInput): void {
  const dedupKey = `${input.jobId}:${input.status}`;
  if (notifiedTerminals.has(dedupKey)) return;
  notifiedTerminals.add(dedupKey);

  const message = summaryFor(input);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ToastEventDetail>(TOAST_EVENT, {
        detail: {
          status: input.status,
          jobName: input.jobName,
          jobId: input.jobId,
          message,
        },
      }),
    );
  }

  if (isTabFocused()) return;

  ensureTitlePrefix(input.status === "completed" ? "✓ " : "⚠ ");

  const Ctor = getNotificationCtor();
  if (!Ctor || Ctor.permission !== "granted") return;
  try {
    // Safari and a few WebViews still throw synchronously here when
    // permission was granted in a prior session but the construction
    // happens outside an active gesture (which is exactly our case:
    // the terminal SSE frame can arrive minutes after the click).
    // Toast + title prefix above already covered the user.
    const n = new Ctor(
      input.status === "completed"
        ? "Training run completed"
        : "Training run failed",
      {
        body: message,
        tag: `arkor-job-${input.jobId}`,
      },
    );
    n.onclick = () => {
      window.focus();
      // `parseRoute()` does not decode path segments, so leave the id
      // raw here to match the unencoded links emitted from JobsTable.
      window.location.hash = `#/jobs/${input.jobId}`;
      n.close();
    };
  } catch {
    // intentional: see comment above
  }
}

export const TOAST_EVENT_NAME = TOAST_EVENT;

export function _resetNotifyForTest(): void {
  notifiedTerminals.clear();
}
