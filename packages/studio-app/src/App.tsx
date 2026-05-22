import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { Overview } from "./pages/Overview";
import { JobsList } from "./pages/JobsList";
import { JobDetail } from "./pages/JobDetail";
import { Playground } from "./pages/Playground";
import { EndpointsList, EndpointDetail } from "./pages/Endpoints";
import { fetchCredentials, type Credentials } from "./lib/api";
import { useHashRoute } from "./route";

export function App() {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useHashRoute();

  useEffect(() => {
    let cancelled = false;
    fetchCredentials()
      .then((c) => {
        if (!cancelled) setCreds(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell creds={creds} error={error} route={route}>
      {route.kind === "home" && <Overview />}
      {route.kind === "jobs" && <JobsList />}
      {route.kind === "job" && <JobDetail jobId={route.id} />}
      {route.kind === "playground" && (
        <Playground initialAdapterId={route.adapterJobId} />
      )}
      {route.kind === "endpoints" && <EndpointsList />}
      {/*
        `key={route.id}` forces React to mount a *fresh* `EndpointDetail`
        instance whenever the URL switches between endpoint detail
        routes. Without it React would reuse the existing component
        across `#/endpoints/A` → `#/endpoints/B` and the new id render
        once with B's action handlers but A's stale `deployment` /
        `keys` / `revealed` state — a fast Enable / Delete / Revoke
        click landing in that window would mutate the wrong deployment.
        The per-id `useEffect` already clears state, but it runs *after*
        the first paint of the new id, so the visible window of stale
        UI matters.
      */}
      {route.kind === "endpoint" && (
        <EndpointDetail key={route.id} id={route.id} />
      )}
    </AppShell>
  );
}
