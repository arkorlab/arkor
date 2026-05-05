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
 */
export type HashChangeDecision =
  | { kind: "ignore" }
  | { kind: "rollback" }
  | { kind: "navigate"; route: Route };

export function evaluateHashChange(opts: {
  newHash: string;
  lastHash: string;
  guards: Iterable<NavigationGuard>;
}): HashChangeDecision {
  // The rollback below uses `history.back()`, which fires another
  // `hashchange`. By the time it lands, the URL has returned to
  // `lastHash` so this branch resolves to `ignore` and the handler does
  // nothing — no need for a manual recursion flag.
  if (opts.newHash === opts.lastHash) return { kind: "ignore" };
  for (const guard of opts.guards) {
    if (!guard()) return { kind: "rollback" };
  }
  return { kind: "navigate", route: parseRoute() };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    let lastHash = window.location.hash;
    const handler = () => {
      const decision = evaluateHashChange({
        newHash: window.location.hash,
        lastHash,
        guards: navigationGuards,
      });
      if (decision.kind === "ignore") return;
      if (decision.kind === "rollback") {
        // Move the history pointer back instead of `replaceState`-ing the
        // current entry: `replaceState` would leave duplicate `#/...`
        // entries in the back stack, so after a cancelled navigation the
        // user would have to press Back twice to escape this page. With
        // `history.back()` the URL bar restores to `lastHash` and the
        // forward stack still holds the rejected destination — Forward
        // re-prompts via the same guard if they change their mind.
        history.back();
        return;
      }
      lastHash = window.location.hash;
      setRoute(decision.route);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}
