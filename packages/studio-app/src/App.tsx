import { useEffect, useState } from "react";
import { JobsList } from "./pages/JobsList";
import { JobDetail } from "./pages/JobDetail";
import { Playground } from "./pages/Playground";
import { RunTraining } from "./components/RunTraining";
import { fetchCredentials, type Credentials } from "./lib/api";

type Route =
  | { kind: "home" }
  | { kind: "job"; id: string }
  | { kind: "playground" };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("jobs/")) {
    const id = hash.slice("jobs/".length);
    if (id) return { kind: "job", id };
  }
  if (hash === "playground") return { kind: "playground" };
  return { kind: "home" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}

export function App() {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useHashRoute();

  useEffect(() => {
    fetchCredentials()
      .then((c) => setCreds(c))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Arkor Studio</h1>
        <nav>
          <a href="#/">Jobs</a>
          <a href="#/playground">Playground</a>
        </nav>
        <div className="identity">
          {error
            ? `error: ${error}`
            : creds
              ? `${creds.mode === "anon" ? "anonymous" : "auth0"} · ${creds.orgSlug ?? "no org"}${creds.projectSlug ? ` / ${creds.projectSlug}` : ""} · ${creds.baseUrl}`
              : "connecting…"}
        </div>
      </header>

      <main>
        {route.kind === "home" && (
          <div className="columns">
            <section>
              <h2>Run training</h2>
              <RunTraining />
            </section>
            <section>
              <JobsList />
            </section>
          </div>
        )}
        {route.kind === "job" && <JobDetail jobId={route.id} />}
        {route.kind === "playground" && <Playground />}
      </main>
    </div>
  );
}
