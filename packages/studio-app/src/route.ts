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
  return {
    kind: "navigate",
    route: parseRoute(),
    newSeq: opts.lastSeq + 1,
  };
}

function readSeqFromState(): number | null {
  const state = (history.state ?? null) as { seq?: unknown } | null;
  return typeof state?.seq === "number" ? state.seq : null;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    let lastHash = window.location.hash;
    // Anchor the initial entry with `seq: 0` so direction detection
    // works for the very first navigation. Preserve any pre-existing
    // state put there by other code (currently none, but cheap to do).
    const existingState = (history.state ?? {}) as Record<string, unknown>;
    let lastSeq =
      typeof existingState.seq === "number" ? existingState.seq : 0;
    if (typeof existingState.seq !== "number") {
      history.replaceState({ ...existingState, seq: 0 }, "");
    }
    const handler = () => {
      const decision = evaluateHashChange({
        newHash: window.location.hash,
        lastHash,
        currentSeq: readSeqFromState(),
        lastSeq,
        guards: navigationGuards,
      });
      if (decision.kind === "ignore") return;
      if (decision.kind === "rollback") {
        if (decision.direction === "back") history.back();
        else history.forward();
        return;
      }
      lastHash = window.location.hash;
      lastSeq = decision.newSeq;
      // Stamp the seq into the *current* entry (the one we just landed
      // on via push) so a future Back from here lands on the previous
      // entry's lower seq, and our direction detection picks "forward"
      // to roll back correctly.
      const state = (history.state ?? {}) as Record<string, unknown>;
      history.replaceState({ ...state, seq: decision.newSeq }, "");
      setRoute(decision.route);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}
