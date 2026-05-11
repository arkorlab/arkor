import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { Overview } from "./pages/Overview";
import { JobsList } from "./pages/JobsList";
import { JobDetail } from "./pages/JobDetail";
import { Playground } from "./pages/Playground";
import { ToastProvider } from "./components/ui/Toast";
import { fetchCredentials, type Credentials } from "./lib/api";
import { useHashRoute } from "./route";

const DEFAULT_TITLE = "Arkor";

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

  // Drop any `✓` / `⚠` prefix that a prior `notifyJobTerminal` left on the
  // tab title once the user navigates. Without this the indicator persists
  // across job pages and prefixes from different jobs accumulate.
  const routeKey =
    route.kind === "job"
      ? `job:${route.id}`
      : route.kind === "playground"
        ? `playground:${route.adapterJobId ?? ""}`
        : route.kind;
  useEffect(() => {
    document.title = DEFAULT_TITLE;
  }, [routeKey]);

  return (
    <>
      <AppShell creds={creds} error={error} route={route}>
        {route.kind === "home" && <Overview />}
        {route.kind === "jobs" && <JobsList />}
        {route.kind === "job" && <JobDetail jobId={route.id} />}
        {route.kind === "playground" && (
          <Playground initialAdapterId={route.adapterJobId} />
        )}
      </AppShell>
      <ToastProvider />
    </>
  );
}
