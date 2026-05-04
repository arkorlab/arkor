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
 * A guard returns `false` to *block* a pending hash navigation (the
 * router will then snap the URL back to the previous hash and skip the
 * route update). Used by pages that hold un-recoverable state — the
 * `EndpointDetail` page registers a guard while a one-time API key
 * `plaintext` response is in flight, so any nav-tab click / back button
 * has to confirm before losing the secret.
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

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    let lastHash = window.location.hash;
    const handler = () => {
      const newHash = window.location.hash;
      // A guard's `replaceState` below restores `lastHash`; that change
      // does not fire `hashchange`, but a subsequent user click on the
      // *same* link would. Bail early when the URL matches what we
      // already have so the same confirm dialog doesn't pop twice.
      if (newHash === lastHash) return;
      for (const guard of navigationGuards) {
        if (!guard()) {
          // Restore the previous hash without triggering another
          // `hashchange` (and so without re-running this handler).
          // `replaceState` is the only way to do that; assigning to
          // `location.hash` would fire another event.
          history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}${lastHash}`,
          );
          return;
        }
      }
      lastHash = newHash;
      setRoute(parseRoute());
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}
