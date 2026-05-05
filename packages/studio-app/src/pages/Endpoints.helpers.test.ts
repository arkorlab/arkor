import { describe, expect, it, vi } from "vitest";
import {
  KEY_ISSUE_DISPLAYED_MESSAGE,
  KEY_ISSUE_INFLIGHT_MESSAGE,
  pollDeploymentsForSlug,
  setupKeyIssueGuards,
} from "./Endpoints.helpers";
import type { Deployment } from "../lib/api";
import type { NavigationGuard } from "../route";

// `Endpoints.tsx`'s component-level wiring isn't directly testable
// without a DOM (no `@testing-library/react` / `jsdom` in this
// workspace), so the resilience-critical parts — the post-abort
// polling loop and the one-time-key navigation-guard wiring — were
// extracted into pure helpers. These tests cover the branches that
// would otherwise only show up in-browser when a user cancels a
// create or starts issuing a key.

function deployment(slug: string): Deployment {
  return {
    id: `id-${slug}`,
    slug,
    orgId: "o",
    projectId: "p",
    target: { kind: "base_model", baseModel: "m" },
    authMode: "none",
    urlFormat: "openai_compat",
    enabled: true,
    customDomain: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("pollDeploymentsForSlug", () => {
  it("stops at the first attempt when the slug is already present", async () => {
    const updates: Deployment[][] = [];
    const fetchDeployments = vi.fn(async () => ({
      deployments: [deployment("first"), deployment("second")],
      scopeMissing: false,
    }));
    await pollDeploymentsForSlug({
      slug: "first",
      signal: new AbortController().signal,
      fetchDeployments,
      onUpdate: ({ deployments }) => updates.push(deployments),
      onError: () => {
        throw new Error("should not error");
      },
      delay: async () => {
        throw new Error("first attempt should not delay");
      },
    });
    // Single fetch — the slug was visible immediately, so no poll loop
    // and no follow-up wait.
    expect(fetchDeployments).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it("keeps polling until the target slug appears, then stops", async () => {
    // Server commits the row on the third snapshot. The poll must
    // surface every interim update (so the SPA stays in sync) and
    // stop the loop the moment the slug is visible.
    const snapshots: Deployment[][] = [
      [], // attempt 0: pre-commit
      [deployment("other")], // attempt 1: someone else added a row
      [deployment("other"), deployment("target")], // attempt 2: our row landed
      [deployment("target"), deployment("extra")], // never visited
    ];
    let calls = 0;
    const updates: Deployment[][] = [];
    let delays = 0;
    await pollDeploymentsForSlug({
      slug: "target",
      signal: new AbortController().signal,
      fetchDeployments: async () => ({ deployments: snapshots[calls++]! }),
      onUpdate: ({ deployments }) => updates.push(deployments),
      onError: () => {
        throw new Error("should not error");
      },
      delay: async () => {
        delays++;
      },
    });
    expect(calls).toBe(3);
    expect(updates.map((d) => d.map((x) => x.slug))).toEqual([
      [],
      ["other"],
      ["other", "target"],
    ]);
    // 3 fetches => 2 inter-attempt delays. The first attempt has no
    // preceding wait — it fires immediately because the parent has
    // just aborted a POST and the server commit is most likely to
    // race the very first reload.
    expect(delays).toBe(2);
  });

  it("gives up after maxAttempts without forwarding the slug", async () => {
    // The server never commits the row (the POST really was aborted
    // before commit). Bound the poll so a forgotten request doesn't
    // keep hammering the cloud API forever.
    let calls = 0;
    await pollDeploymentsForSlug({
      slug: "missing",
      signal: new AbortController().signal,
      fetchDeployments: async () => {
        calls++;
        return { deployments: [deployment("other")] };
      },
      onUpdate: () => undefined,
      onError: () => {
        throw new Error("should not error on a clean miss");
      },
      maxAttempts: 4,
      delay: async () => undefined,
    });
    expect(calls).toBe(4);
  });

  it("forwards a non-abort fetch error via onError and stops the poll", async () => {
    let calls = 0;
    let errored = "";
    await pollDeploymentsForSlug({
      slug: "x",
      signal: new AbortController().signal,
      fetchDeployments: async () => {
        calls++;
        if (calls === 2) throw new Error("transport blew up");
        return { deployments: [] };
      },
      onUpdate: () => undefined,
      onError: (msg) => {
        errored = msg;
      },
      delay: async () => undefined,
    });
    expect(calls).toBe(2);
    expect(errored).toBe("transport blew up");
  });

  it("swallows AbortError and stops without surfacing an error", async () => {
    // AbortError on the in-flight fetch is the expected hand-off when
    // the parent supersedes us; surfacing it as a user-visible error
    // would flash a spurious red banner on a successful retry.
    const ctrl = new AbortController();
    let onErrorCalled = false;
    await pollDeploymentsForSlug({
      slug: "x",
      signal: ctrl.signal,
      fetchDeployments: async () => {
        const err = new DOMException("aborted", "AbortError");
        throw err;
      },
      onUpdate: () => undefined,
      onError: () => {
        onErrorCalled = true;
      },
      delay: async () => undefined,
    });
    expect(onErrorCalled).toBe(false);
  });

  it("bails immediately when the external signal is already aborted", async () => {
    // Caller superseded us before the loop could even start. We must
    // fire zero `fetchDeployments` calls and zero `onUpdate` /
    // `onError` callbacks — otherwise we'd race state with whatever
    // replaced us.
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchDeployments = vi.fn();
    const onUpdate = vi.fn();
    const onError = vi.fn();
    await pollDeploymentsForSlug({
      slug: "x",
      signal: ctrl.signal,
      fetchDeployments,
      onUpdate,
      onError,
      delay: async () => undefined,
    });
    expect(fetchDeployments).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("setupKeyIssueGuards", () => {
  // Three layers of defence (beforeunload, navigation guard,
  // unmount-abort) all set up by one helper. These tests verify the
  // registration order, that the guard picks the right confirm copy
  // for each phase, and that the cleanup tears everything down — any
  // regression here can let a user lose an unrecoverable API key
  // secret, so it's worth pinning the wiring even though no DOM is
  // involved.

  function makeFakes(opts: {
    isPending?: () => boolean;
    isPostInFlight?: () => boolean;
    confirmAnswer?: boolean;
    controller?: AbortController | null;
  } = {}) {
    const beforeUnloadListeners: Array<(e: BeforeUnloadEvent) => void> = [];
    const guardRegistrations: NavigationGuard[] = [];
    const confirmCalls: string[] = [];
    let unregisterCalls = 0;
    const onAcceptedLossCalls: number[] = [];
    const fakes = {
      isPending: opts.isPending ?? (() => true),
      isPostInFlight: opts.isPostInFlight ?? (() => true),
      getKeyIssueController: () => opts.controller ?? null,
      registerNavigationGuard: (g: NavigationGuard) => {
        guardRegistrations.push(g);
        return () => {
          unregisterCalls++;
        };
      },
      addBeforeUnloadListener: (h: (e: BeforeUnloadEvent) => void) => {
        beforeUnloadListeners.push(h);
      },
      removeBeforeUnloadListener: (h: (e: BeforeUnloadEvent) => void) => {
        const idx = beforeUnloadListeners.indexOf(h);
        if (idx >= 0) beforeUnloadListeners.splice(idx, 1);
      },
      confirm: (msg: string) => {
        confirmCalls.push(msg);
        return opts.confirmAnswer ?? false;
      },
      onAcceptedLoss: () => {
        onAcceptedLossCalls.push(Date.now());
      },
    };
    return {
      fakes,
      beforeUnloadListeners,
      guardRegistrations,
      confirmCalls,
      getUnregisterCalls: () => unregisterCalls,
      onAcceptedLossCalls,
    };
  }

  it("registers a beforeunload listener and a navigation guard on setup", () => {
    const f = makeFakes();
    setupKeyIssueGuards(f.fakes);
    expect(f.beforeUnloadListeners).toHaveLength(1);
    expect(f.guardRegistrations).toHaveLength(1);
  });

  it("the cleanup unregisters the guard, removes the listener, and aborts the controller", () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");
    const f = makeFakes({ controller });
    const cleanup = setupKeyIssueGuards(f.fakes);
    cleanup();
    expect(f.beforeUnloadListeners).toHaveLength(0);
    expect(f.getUnregisterCalls()).toBe(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("cleanup tolerates a null controller (no key request was in flight)", () => {
    // First mount before any Issue key click — `keyIssueControllerRef`
    // is still null, and the cleanup must not crash trying to
    // `?.abort()` it.
    const f = makeFakes({ controller: null });
    const cleanup = setupKeyIssueGuards(f.fakes);
    expect(() => cleanup()).not.toThrow();
  });

  it("beforeunload no-ops while no key is being issued", () => {
    let pending = false;
    const f = makeFakes({ isPending: () => pending });
    setupKeyIssueGuards(f.fakes);
    const e = new Event("beforeunload") as BeforeUnloadEvent;
    const preventDefault = vi.spyOn(e, "preventDefault");
    f.beforeUnloadListeners[0]!(e);
    expect(preventDefault).not.toHaveBeenCalled();
    pending = true;
    f.beforeUnloadListeners[0]!(e);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("navigation guard returns true (allow) when nothing is pending", () => {
    const f = makeFakes({ isPending: () => false });
    setupKeyIssueGuards(f.fakes);
    expect(f.guardRegistrations[0]!()).toBe(true);
    // No confirm prompt fires when there's nothing to lose.
    expect(f.confirmCalls).toEqual([]);
  });

  it("navigation guard prompts with the in-flight copy while POST is running", () => {
    const f = makeFakes({
      isPending: () => true,
      isPostInFlight: () => true,
      confirmAnswer: false,
    });
    setupKeyIssueGuards(f.fakes);
    const allowed = f.guardRegistrations[0]!();
    expect(f.confirmCalls).toEqual([KEY_ISSUE_INFLIGHT_MESSAGE]);
    // User cancelled — block the navigation, don't release the guard.
    expect(allowed).toBe(false);
    expect(f.onAcceptedLossCalls).toHaveLength(0);
  });

  it("navigation guard prompts with the displayed copy when the plaintext is on screen", () => {
    const f = makeFakes({
      isPending: () => true,
      isPostInFlight: () => false,
      confirmAnswer: false,
    });
    setupKeyIssueGuards(f.fakes);
    f.guardRegistrations[0]!();
    expect(f.confirmCalls).toEqual([KEY_ISSUE_DISPLAYED_MESSAGE]);
    // Sanity check: the two messages differ. If they ever drift back
    // to the same string, the dropdown-copy distinction this whole
    // ref dance exists to maintain is gone.
    expect(KEY_ISSUE_INFLIGHT_MESSAGE).not.toBe(KEY_ISSUE_DISPLAYED_MESSAGE);
  });

  it("user accepting the prompt allows navigation AND fires onAcceptedLoss", () => {
    // The caller uses `onAcceptedLoss` to clear the protection flag
    // so subsequent navigations flow through unimpeded — without it
    // the guard would re-prompt on every link click forever.
    const f = makeFakes({
      isPending: () => true,
      isPostInFlight: () => true,
      confirmAnswer: true,
    });
    setupKeyIssueGuards(f.fakes);
    const allowed = f.guardRegistrations[0]!();
    expect(allowed).toBe(true);
    expect(f.onAcceptedLossCalls).toHaveLength(1);
  });
});
