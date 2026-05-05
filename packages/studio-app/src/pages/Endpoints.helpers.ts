/**
 * Pure helpers extracted from `Endpoints.tsx` so the resilience logic
 * (post-abort polling, key-issue guard wiring) is unit-testable
 * without standing up a DOM or a React renderer. Each helper takes
 * its dependencies as parameters so tests can pass mocks for
 * `fetchDeployments`, `registerNavigationGuard`, `addEventListener`,
 * etc.
 */
import type { Deployment } from "../lib/api";
import type { NavigationGuard } from "../route";

export interface PollDeploymentsForSlugOptions {
  /** The slug we're waiting to see in the list. */
  slug: string;
  /**
   * Bound `fetchDeployments` (or a stand-in). Called once per attempt
   * with the cancellation `signal` from `opts.signal`.
   */
  fetchDeployments: (opts: {
    signal: AbortSignal;
  }) => Promise<{ deployments: Deployment[]; scopeMissing?: boolean }>;
  /** External cancellation signal. The poll bails as soon as this aborts. */
  signal: AbortSignal;
  /** Called whenever a fresh list lands (so the SPA can reflect it). */
  onUpdate: (result: {
    deployments: Deployment[];
    scopeMissing?: boolean;
  }) => void;
  /** Called once if any non-abort error escapes a `fetchDeployments` call. */
  onError: (message: string) => void;
  /** Default 6. Total polls is `maxAttempts`; the last one has no follow-up wait. */
  maxAttempts?: number;
  /**
   * Default 500. Wait between attempts. Tests pass a tiny value to keep
   * the suite fast. We only wait *between* attempts, not before the
   * first one — by the time this helper is called, the parent has just
   * aborted a POST, so the very first attempt is the most likely to
   * still race the server commit.
   */
  delayMs?: number;
  /**
   * Indirection for the wait between attempts. Real callers don't pass
   * this; tests inject a synchronous resolver to step through attempts
   * deterministically.
   */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Recover from a `createDeployment` POST that was aborted client-side
 * while the server may have already committed the row. Polls
 * `fetchDeployments` until either the new slug appears (the row really
 * did commit) or the budget is exhausted (orphan row, or the abort
 * actually beat the commit). Returns nothing — state propagation is
 * fully done through `onUpdate` / `onError`.
 *
 * Detection is by *slug match* rather than count delta. A length-only
 * heuristic stops too early when (a) the initial fetch hadn't returned
 * yet so the count baseline is 0 despite existing rows, or (b) another
 * tab / CLI added a different deployment first — `length > baseline`
 * would fire and we'd still miss the slug we actually care about.
 */
export async function pollDeploymentsForSlug(
  options: PollDeploymentsForSlugOptions,
): Promise<void> {
  const {
    slug,
    fetchDeployments,
    signal,
    onUpdate,
    onError,
    maxAttempts = 6,
    delayMs = 500,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return;
    if (attempt > 0) {
      await delay(delayMs);
    }
    if (signal.aborted) return;
    try {
      const result = await fetchDeployments({ signal });
      if (signal.aborted) return;
      onUpdate(result);
      if (result.deployments.some((d) => d.slug === slug)) return;
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg =
        err instanceof Error ? err.message : String(err);
      onError(msg);
      return;
    }
  }
}

/**
 * Imperative-side-effects view of the EndpointDetail page's "the user
 * is mid-issuing a one-time API key, do not let them lose the
 * plaintext" wiring. Returns a cleanup function the caller runs from
 * a `useEffect` cleanup. Extracted so tests can verify all three
 * defenses (beforeunload prompt, navigation-guard prompt, unmount
 * abort) actually fire — and stay in sync with each other — without
 * standing up a DOM.
 */
export interface KeyIssueGuardOptions {
  /** Read whether there's an un-recoverable secret to protect. */
  isPending: () => boolean;
  /** Read whether the POST is still actively running (vs already settled). */
  isPostInFlight: () => boolean;
  /** Read the in-flight controller for the unmount abort. */
  getKeyIssueController: () => AbortController | null;
  /** The router's navigation-guard registry. */
  registerNavigationGuard: (guard: NavigationGuard) => () => void;
  /** Injection point so tests can avoid touching `window`. */
  addBeforeUnloadListener: (handler: (e: BeforeUnloadEvent) => void) => void;
  removeBeforeUnloadListener: (
    handler: (e: BeforeUnloadEvent) => void,
  ) => void;
  /**
   * Window confirm prompt; tests inject a stub so they can answer
   * Yes / No deterministically. Real callers use `window.confirm`.
   */
  confirm: (message: string) => boolean;
  /**
   * Called when the user accepts losing the plaintext at the confirm
   * dialog — the caller should clear `pendingKeyIssueRef` so
   * subsequent navigations flow through.
   */
  onAcceptedLoss: () => void;
}

export const KEY_ISSUE_INFLIGHT_MESSAGE =
  "An API key is being issued. Leaving now will lose the one-time secret. Continue anyway?";
export const KEY_ISSUE_DISPLAYED_MESSAGE =
  "The just-issued API key is shown on screen but you haven't confirmed you saved it. Leaving now will discard the only copy. Continue anyway?";

export function setupKeyIssueGuards(opts: KeyIssueGuardOptions): () => void {
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!opts.isPending()) return;
    // Modern browsers (Chrome 119+, Firefox, Safari) show the generic
    // confirm dialog from `preventDefault()` alone — the custom
    // message is no longer rendered, so we don't bother with the
    // deprecated `returnValue`. Goal: stop the user from losing the
    // one-time plaintext key by closing the tab mid-flight.
    e.preventDefault();
  }

  const unregisterGuard = opts.registerNavigationGuard(() => {
    if (!opts.isPending()) return true;
    // Pick copy that matches the actual phase. Telling the user the
    // key is "being issued" while it's actually already on screen
    // would mislead them about what they're about to lose.
    const message = opts.isPostInFlight()
      ? KEY_ISSUE_INFLIGHT_MESSAGE
      : KEY_ISSUE_DISPLAYED_MESSAGE;
    const proceed = opts.confirm(message);
    if (proceed) {
      opts.onAcceptedLoss();
    }
    return proceed;
  });
  opts.addBeforeUnloadListener(onBeforeUnload);

  return () => {
    unregisterGuard();
    opts.removeBeforeUnloadListener(onBeforeUnload);
    // Component is being torn down: best-effort abort the in-flight
    // POST so the network layer drops the response. If the server
    // already committed, the key will show up the next time the user
    // opens this endpoint and is revocable from the list.
    opts.getKeyIssueController()?.abort();
  };
}
