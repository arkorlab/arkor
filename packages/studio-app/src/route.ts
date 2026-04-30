import { useEffect, useState } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "jobs" }
  | { kind: "job"; id: string }
  | { kind: "playground" };

export function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "jobs") return { kind: "jobs" };
  if (hash.startsWith("jobs/")) {
    const id = hash.slice("jobs/".length);
    if (id) return { kind: "job", id };
  }
  if (hash === "playground") return { kind: "playground" };
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
