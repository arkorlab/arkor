import { useEffect, useState } from "react";
import { JobsList } from "./pages/JobsList";
import { JobDetail } from "./pages/JobDetail";
import { Playground } from "./pages/Playground";
import { RunTraining } from "./components/RunTraining";
import { fetchCredentials, type Credentials } from "./lib/api";

const PRODUCTION_CLOUD_API_URL = "https://api.arkor.ai";

// Hide the cloud-api URL from the identity header when pointing at the
// production endpoint — regular users don't need it. For Arkor contributors
// running against a local cloud-api (`ARKOR_CLOUD_API_URL=...`), surface just
// the host:port so it's clear which backend the Studio is talking to without
// the protocol noise.
function formatIdentityBaseUrl(baseUrl: string): string | null {
  // Strip trailing slash before comparing — the server normalises env-var
  // overrides via `defaultArkorCloudApiUrl()` today, but a future change that
  // forwards the raw value would otherwise let `https://api.arkor.ai/` slip
  // past the production check and surface in the header.
  if (baseUrl.replace(/\/$/, "") === PRODUCTION_CLOUD_API_URL) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function formatIdentity(creds: Credentials): string {
  const mode = creds.mode === "anon" ? "anonymous" : "auth0";
  const org = creds.orgSlug ?? "no org";
  const project = creds.projectSlug ? ` / ${creds.projectSlug}` : "";
  const baseUrlLabel = formatIdentityBaseUrl(creds.baseUrl);
  const baseUrlSuffix = baseUrlLabel ? ` · ${baseUrlLabel}` : "";
  return `${mode} · ${org}${project}${baseUrlSuffix}`;
}

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
              ? formatIdentity(creds)
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
