// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOAST_EVENT_NAME,
  _resetNotifyForTest,
  ensurePermissionOnGesture,
  notifyJobTerminal,
  type ToastEventDetail,
} from "./notify";

interface FakeNotificationInstance {
  title: string;
  options: NotificationOptions | undefined;
  onclick: ((this: Notification, ev: Event) => unknown) | null;
  close: ReturnType<typeof vi.fn>;
}

function installFakeNotification(
  permission: NotificationPermission,
  requestPermissionImpl?: () => Promise<NotificationPermission>,
): {
  instances: FakeNotificationInstance[];
  requestPermission: ReturnType<typeof vi.fn>;
} {
  const instances: FakeNotificationInstance[] = [];
  const requestPermission = vi.fn(
    requestPermissionImpl ?? (() => Promise.resolve(permission)),
  );
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    title: string;
    options: NotificationOptions | undefined;
    onclick: FakeNotificationInstance["onclick"] = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
  }
  (globalThis as unknown as { Notification: typeof FakeNotification }).Notification =
    FakeNotification;
  return { instances, requestPermission };
}

function uninstallNotification() {
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
}

function setVisibility(
  state: "visible" | "hidden",
  hasFocus: boolean = state === "visible",
) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  Object.defineProperty(document, "hasFocus", {
    value: () => hasFocus,
    configurable: true,
  });
}

beforeEach(() => {
  _resetNotifyForTest();
  document.title = "Arkor";
});

afterEach(() => {
  uninstallNotification();
  vi.restoreAllMocks();
});

describe("ensurePermissionOnGesture", () => {
  it("requests permission only when current state is default", () => {
    const { requestPermission } = installFakeNotification("default");
    ensurePermissionOnGesture();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does nothing when permission is already granted", () => {
    const { requestPermission } = installFakeNotification("granted");
    ensurePermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does nothing when permission is denied", () => {
    const { requestPermission } = installFakeNotification("denied");
    ensurePermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does nothing when Notification API is absent", () => {
    uninstallNotification();
    expect(() => ensurePermissionOnGesture()).not.toThrow();
  });

  it("swallows synchronous throws from requestPermission", () => {
    installFakeNotification("default", () => {
      throw new Error("blocked");
    });
    expect(() => ensurePermissionOnGesture()).not.toThrow();
  });
});

describe("notifyJobTerminal", () => {
  it("fires an OS Notification when granted and tab is hidden", () => {
    setVisibility("hidden");
    const { instances } = installFakeNotification("granted");
    const detail: ToastEventDetail[] = [];
    window.addEventListener(TOAST_EVENT_NAME, ((ev: Event) => {
      detail.push((ev as CustomEvent<ToastEventDetail>).detail);
    }) as EventListener);

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-1",
      artifacts: 3,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]?.title).toBe("Training run completed");
    expect(instances[0]?.options?.body).toBe("demo (3 artifacts)");
    expect(instances[0]?.options?.tag).toBe("arkor-job-job-1");
    expect(detail).toHaveLength(1);
    expect(detail[0]?.message).toBe("demo (3 artifacts)");
    expect(document.title.startsWith("✓ ")).toBe(true);
  });

  it("only emits a toast when the tab is focused (no OS notification, no title prefix)", () => {
    setVisibility("visible");
    const { instances } = installFakeNotification("granted");
    const detail: ToastEventDetail[] = [];
    window.addEventListener(TOAST_EVENT_NAME, ((ev: Event) => {
      detail.push((ev as CustomEvent<ToastEventDetail>).detail);
    }) as EventListener);

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-2",
      artifacts: 1,
    });

    expect(instances).toHaveLength(0);
    expect(detail).toHaveLength(1);
    expect(document.title).toBe("Arkor");
  });

  it("uses the warning prefix and constructs no Notification when permission is denied", () => {
    setVisibility("hidden");
    const { instances } = installFakeNotification("denied");
    const detail: ToastEventDetail[] = [];
    window.addEventListener(TOAST_EVENT_NAME, ((ev: Event) => {
      detail.push((ev as CustomEvent<ToastEventDetail>).detail);
    }) as EventListener);

    notifyJobTerminal({
      status: "failed",
      jobName: "demo",
      jobId: "job-3",
      error: "boom",
    });

    expect(instances).toHaveLength(0);
    expect(detail).toHaveLength(1);
    expect(detail[0]?.message).toBe("demo failed: boom");
    expect(document.title.startsWith("⚠ ")).toBe(true);
  });

  it("deduplicates repeat calls for the same (jobId, status)", () => {
    setVisibility("hidden");
    const { instances } = installFakeNotification("granted");
    const detail: ToastEventDetail[] = [];
    window.addEventListener(TOAST_EVENT_NAME, ((ev: Event) => {
      detail.push((ev as CustomEvent<ToastEventDetail>).detail);
    }) as EventListener);

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-4",
      artifacts: 2,
    });
    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-4",
      artifacts: 2,
    });

    expect(instances).toHaveLength(1);
    expect(detail).toHaveLength(1);
  });

  it("allows the same job to notify on a different terminal status (failed after completed)", () => {
    setVisibility("hidden");
    installFakeNotification("granted");

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-5",
    });
    notifyJobTerminal({
      status: "failed",
      jobName: "demo",
      jobId: "job-5",
      error: "x",
    });

    // The new prefix replaces the old one rather than stacking.
    expect(document.title).toBe("⚠ Arkor");
  });

  it("replaces an existing prefix instead of stacking when the status differs", () => {
    setVisibility("hidden");
    installFakeNotification("granted");

    notifyJobTerminal({ status: "completed", jobName: "A", jobId: "job-A" });
    notifyJobTerminal({ status: "failed", jobName: "B", jobId: "job-B" });

    expect(document.title).toBe("⚠ Arkor");
  });

  it("treats a visible tab that is not focused as backgrounded (fires OS notification)", () => {
    setVisibility("visible", false);
    const { instances } = installFakeNotification("granted");

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-bg",
      artifacts: 1,
    });

    expect(instances).toHaveLength(1);
    expect(document.title.startsWith("✓ ")).toBe(true);
  });

  it("does not stack the same title prefix repeatedly", () => {
    setVisibility("hidden");
    installFakeNotification("granted");

    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-6",
    });
    notifyJobTerminal({
      status: "completed",
      jobName: "demo",
      jobId: "job-7",
    });

    const matches = document.title.match(/✓ /g);
    expect(matches?.length).toBe(1);
  });

  it("survives without the Notification API at all (toast still fires)", () => {
    setVisibility("hidden");
    uninstallNotification();
    const detail: ToastEventDetail[] = [];
    window.addEventListener(TOAST_EVENT_NAME, ((ev: Event) => {
      detail.push((ev as CustomEvent<ToastEventDetail>).detail);
    }) as EventListener);

    expect(() =>
      notifyJobTerminal({
        status: "completed",
        jobName: "demo",
        jobId: "job-8",
      }),
    ).not.toThrow();
    expect(detail).toHaveLength(1);
  });
});
