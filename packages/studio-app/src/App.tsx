import { useEffect, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { Overview } from "./pages/Overview";
import { JobsList } from "./pages/JobsList";
import { JobDetail } from "./pages/JobDetail";
import { Playground } from "./pages/Playground";
import { fetchCredentials, type Credentials } from "./lib/api";
import { useHashRoute } from "./route";

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
    <AppShell creds={creds} error={error} route={route}>
      {route.kind === "home" && <Overview />}
      {route.kind === "jobs" && <JobsList />}
      {route.kind === "job" && <JobDetail jobId={route.id} />}
      {route.kind === "playground" && <Playground />}
    </AppShell>
  );
}
