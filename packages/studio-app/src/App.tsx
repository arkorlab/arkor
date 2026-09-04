import { useEffect, useState } from "react";

import { AppShell } from "./components/layout/AppShell";
import { fetchCredentials, type Credentials } from "./lib/api";
import { EndpointsList, EndpointDetail } from "./pages/Endpoints";
import { JobDetail } from "./pages/JobDetail";
import { JobsList } from "./pages/JobsList";
import { Overview } from "./pages/Overview";
import { Playground } from "./pages/Playground";
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

  // undefined until /api/credentials settles. Pages that behave
  // differently against a local training server wait for it rather than
  // assuming cloud and correcting themselves a moment later.
  const localMode =
    creds !== null
      ? creds.mode === "local"
      : error !== null
        ? false
        : undefined;

  return (
    <AppShell creds={creds} error={error} route={route}>
      {route.kind === "home" && <Overview />}
      {route.kind === "jobs" && <JobsList />}
      {route.kind === "job" && <JobDetail jobId={route.id} local={localMode} />}
      {/* Mounted only once the mode is known (creds resolved, or their
          load failed and we fall back to cloud behaviour): rendering
          earlier would briefly offer local dry-run jobs as adapters, and
          every inference request against those 404s. */}
      {route.kind === "playground" &&
        (localMode === undefined ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : (
          <Playground initialAdapterId={route.adapterJobId} local={localMode} />
        ))}
      {route.kind === "endpoints" && <EndpointsList local={localMode} />}
      {/*
        `key={route.id}` forces React to mount a *fresh* `EndpointDetail`
        instance whenever the URL switches between endpoint detail
        routes. Without it React would reuse the existing component
        across `#/endpoints/A` → `#/endpoints/B` and the new id render
        once with B's action handlers but A's stale `deployment` /
        `keys` / `revealed` state; a fast Enable / Delete / Revoke
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
