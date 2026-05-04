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

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}
