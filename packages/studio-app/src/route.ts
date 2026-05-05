import { useEffect, useState } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "jobs" }
  | { kind: "job"; id: string }
  | { kind: "playground"; adapterJobId?: string }
  | { kind: "endpoints" }
  | { kind: "endpoint"; id: string };

export function parseRoute(): Route {
  // Split into path / query first; trimming trailing slashes from the
  // raw hash up front would leave them on the path when a query is
  // present (e.g. `#/playground/?adapter=foo` → `playground/?adapter=foo`,
  // since the `/` is no longer at the end of the string), and the
  // route would fall through to `home`. Trim the path-only segment.
  const raw = window.location.hash.replace(/^#\/?/, "");
  const queryStart = raw.indexOf("?");
  const rawPath = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const path = rawPath.replace(/\/+$/, "");
  const query = queryStart === -1 ? "" : raw.slice(queryStart + 1);
  if (path === "jobs") return { kind: "jobs" };
  if (path.startsWith("jobs/")) {
    const id = path.slice("jobs/".length);
    if (id) return { kind: "job", id };
  }
  if (path === "playground") {
    const params = new URLSearchParams(query);
    // Treat blank/whitespace-only `?adapter=` as absent so callers
    // never see an empty string masquerading as a real adapter id.
    const adapterJobId = params.get("adapter")?.trim() || undefined;
    return { kind: "playground", adapterJobId };
  }
  if (path === "endpoints") return { kind: "endpoints" };
  if (path.startsWith("endpoints/")) {
    // The hash segment is URL-encoded — links are constructed via
    // `#/endpoints/${encodeURIComponent(id)}` to keep slashes / reserved
    // chars from breaking the path split. Decode once here so the SPA
    // hands the raw id to `fetchDeployment(id)`, which encodes again on
    // the way to the network. Without this step a slash-containing id
    // (`a/b`) would end up double-encoded (`a%252Fb`) and 404.
    const raw = path.slice("endpoints/".length);
    if (raw) {
      try {
        return { kind: "endpoint", id: decodeURIComponent(raw) };
      } catch {
        // Malformed `%`-escapes (e.g. a stray `%` typed into the URL bar)
        // throw URIError from `decodeURIComponent`. Fall through to home
        // rather than crashing the app.
        return { kind: "home" };
      }
    }
  }
  return { kind: "home" };
}

/**
 * A guard returns `false` to *block* a pending hash navigation. The
 * router then rolls the address bar back to the previous hash via
 * `history.back()` and skips the route update. Used by pages that hold
 * un-recoverable state — the `EndpointDetail` page registers a guard
 * while a one-time API key `plaintext` response is in flight (or
 * displayed but not yet acknowledged), so any nav-tab click / back
 * button has to confirm before losing the secret.
 *
 * Guards run inside the same `hashchange` handler that drives
 * `useHashRoute`, so they fire *before* the route state updates and
 * before any per-page `hashchange` listener — that ordering is what
 * makes the block effective. A per-page listener registered separately
 * runs after `setRoute()` has already torn its component down.
 */
export type NavigationGuard = () => boolean;
const navigationGuards = new Set<NavigationGuard>();

/** Register a `NavigationGuard`; the returned function unregisters it. */
export function registerNavigationGuard(
  guard: NavigationGuard,
): () => void {
  navigationGuards.add(guard);
  return () => {
    navigationGuards.delete(guard);
  };
}

/**
 * Pure decision logic extracted from `useHashRoute` so unit tests can
 * exercise the guard / rollback / pass-through branches without a real
 * DOM. The hook adds the side effects (history rollback, setState).
 *
 * Direction matters for the rollback. The router stamps a monotonic
 * `seq` into `history.state` on every accepted navigation, then compares
 * the live `currentSeq` against the previously-stored `lastSeq` on the
 * next `hashchange`:
 *   - `currentSeq < lastSeq` → user pressed Back / Forward-was-Back →
 *     undo with `history.forward()`. Calling `history.back()` here would
 *     step *further* back and could eject the user from Studio.
 *   - otherwise (forward push from a link click, or a fresh entry whose
 *     `state.seq` is null) → undo with `history.back()`.
 */
export type HashChangeDecision =
  | { kind: "ignore" }
  | { kind: "rollback"; direction: "back" | "forward" }
  | { kind: "navigate"; route: Route; newSeq: number };

export function evaluateHashChange(opts: {
  newHash: string;
  lastHash: string;
  /** `history.state?.seq` at the moment `hashchange` fired, or `null`
   * if the entry was created without our seq tag (e.g. a link click
   * pushed a fresh entry). */
  currentSeq: number | null;
  /** The seq we last stored as the "current" entry. */
  lastSeq: number;
  guards: Iterable<NavigationGuard>;
}): HashChangeDecision {
  // The rollback fires another `hashchange`. By the time it lands, the
  // URL has returned to `lastHash` so this branch resolves to `ignore`
  // and the handler does nothing — no manual recursion flag needed.
  if (opts.newHash === opts.lastHash) return { kind: "ignore" };
  for (const guard of opts.guards) {
    if (!guard()) {
      const direction =
        opts.currentSeq !== null && opts.currentSeq < opts.lastSeq
          ? "forward"
          : "back";
      return { kind: "rollback", direction };
    }
  }
  // For brand-new entries pushed by a forward navigation, `currentSeq`
  // is null and we mint `lastSeq + 1`. For revisited entries (Back /
  // Forward landing on something we already stamped), preserve the
  // existing seq — re-stamping `B` with a higher number than `C` after
  // an A→B→C→Back-to-B sequence would corrupt direction detection on
  // the next Forward and turn the rollback into another `forward()`,
  // ejecting the user further along the stack.
  return {
    kind: "navigate",
    route: parseRoute(),
    newSeq: opts.currentSeq ?? opts.lastSeq + 1,
  };
}

function readSeqFromState(): number | null {
  const state = (history.state ?? null) as { seq?: unknown } | null;
  return typeof state?.seq === "number" ? state.seq : null;
}

/**
 * Side-effect surface used by the hash router. Extracted into an
 * interface so the per-`hashchange` handler can be unit-tested with
 * mocks for `back` / `forward` / `replaceState` / `setRoute` — the
 * actual integration-level logic that protects one-time API keys.
 */
export interface HashRouterDeps {
  /** Read `window.location.hash` (or a test stub). */
  getCurrentHash: () => string;
  /** Read `history.state?.seq`, or `null` if absent. */
  getCurrentSeq: () => number | null;
  /** The active set of navigation guards. */
  guards: Iterable<NavigationGuard>;
  /** Apply the new route to React state. */
  setRoute: (route: Route) => void;
  /** Roll back a forward navigation (`history.back()` in production). */
  goBack: () => void;
  /** Roll back a backward navigation (`history.forward()` in production). */
  goForward: () => void;
  /** Stamp `seq` into the current entry's `history.state`. */
  stampSeq: (seq: number) => void;
}

/**
 * Create the per-`hashchange` handler used by `useHashRoute`. Returned
 * as an object so tests can also inspect `lastHash` / `lastSeq` after
 * dispatching synthetic events.
 */
export function createHashRouter(
  initialHash: string,
  initialSeq: number,
  deps: HashRouterDeps,
): {
  onHashChange: () => void;
  getLastHash: () => string;
  getLastSeq: () => number;
} {
  let lastHash = initialHash;
  let lastSeq = initialSeq;
  return {
    onHashChange: () => {
      const decision = evaluateHashChange({
        newHash: deps.getCurrentHash(),
        lastHash,
        currentSeq: deps.getCurrentSeq(),
        lastSeq,
        guards: deps.guards,
      });
      if (decision.kind === "ignore") return;
      if (decision.kind === "rollback") {
        if (decision.direction === "back") deps.goBack();
        else deps.goForward();
        return;
      }
      lastHash = deps.getCurrentHash();
      lastSeq = decision.newSeq;
      // Stamp the seq only when this entry doesn't already have one
      // (i.e. it's a freshly-pushed entry, not a revisit via Back /
      // Forward). Re-stamping a previously-visited entry would break
      // direction detection on the next navigation; see the comment in
      // `evaluateHashChange` for the full A→B→C→Back→Forward example.
      if (deps.getCurrentSeq() === null) {
        deps.stampSeq(decision.newSeq);
      }
      deps.setRoute(decision.route);
    },
    getLastHash: () => lastHash,
    getLastSeq: () => lastSeq,
  };
}

/**
 * Replace the current history entry with `hash` and synchronously
 * notify `useHashRoute` of the change. Use this for "the page I was on
 * is gone, swap me to a sibling" flows (e.g. post-delete redirect):
 * `pushState`-style navigation would leave the now-404 detail entry
 * one Back press behind the user.
 *
 * `replaceState` does not fire `hashchange` on its own — the manual
 * dispatch is what makes the SPA's router pick up the new URL.
 */
export function navigateReplace(hash: string): void {
  if (window.location.hash === hash) return;
  window.history.replaceState(null, "", hash);
  window.dispatchEvent(new Event("hashchange"));
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    // Anchor the initial entry with `seq: 0` so direction detection
    // works for the very first navigation. Preserve any pre-existing
    // state put there by other code (currently none, but cheap to do).
    const existingState = (history.state ?? {}) as Record<string, unknown>;
    const initialSeq =
      typeof existingState.seq === "number" ? existingState.seq : 0;
    if (typeof existingState.seq !== "number") {
      history.replaceState({ ...existingState, seq: 0 }, "");
    }
    const router = createHashRouter(window.location.hash, initialSeq, {
      getCurrentHash: () => window.location.hash,
      getCurrentSeq: readSeqFromState,
      guards: navigationGuards,
      setRoute,
      goBack: () => history.back(),
      goForward: () => history.forward(),
      stampSeq: (seq) => {
        const state = (history.state ?? {}) as Record<string, unknown>;
        history.replaceState({ ...state, seq }, "");
      },
    });
    window.addEventListener("hashchange", router.onHashChange);
    return () => window.removeEventListener("hashchange", router.onHashChange);
  }, []);
  return route;
}
