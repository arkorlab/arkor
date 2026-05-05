import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  createDeployment,
  createDeploymentKey,
  deleteDeployment,
  DeploymentApiError,
  fetchDeployment,
  fetchDeploymentKeys,
  fetchDeployments,
  revokeDeploymentKey,
  updateDeployment,
  type CreateDeploymentBody,
  type CreatedDeploymentKey,
  type Deployment,
  type DeploymentAuthMode,
  type DeploymentKey,
  type DeploymentTarget,
} from "../lib/api";
import { navigateBackOr, registerNavigationGuard } from "../route";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { CopyButton } from "../components/ui/CopyButton";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";
import { Inbox } from "../components/icons";
import { QuickStart } from "./QuickStart";
import {
  pollDeploymentsForSlug,
  setupKeyIssueGuards,
} from "./Endpoints.helpers";

function describeTarget(target: DeploymentTarget): string {
  if (target.kind === "adapter") {
    return target.adapter.kind === "final"
      ? `Final adapter (job ${target.adapter.jobId.slice(0, 8)})`
      : `Checkpoint step ${target.adapter.step} (job ${target.adapter.jobId.slice(0, 8)})`;
  }
  return `Base model: ${target.baseModel}`;
}

function deploymentUrl(slug: string): string {
  return `https://${slug}.arkor.app/v1/chat/completions`;
}

function asMessage(err: unknown): string {
  if (err instanceof DeploymentApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// List view (default Endpoints route)
// ---------------------------------------------------------------------------

export function EndpointsList() {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  // True when `/api/deployments` returned 200 but the workspace has no
  // `.arkor/state.json` yet, so the empty list is a "we don't know
  // which project to scope to" rather than "this project is empty".
  // The empty-state copy branches on this.
  const [scopeMissing, setScopeMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Track the currently-active in-flight `fetchDeployments` so a slower
  // earlier load (e.g. the initial mount fetch) can't land after a
  // user-triggered reload (post-create) and overwrite the fresh list
  // with a stale snapshot. Each `load()` (and the post-abort poll) aborts
  // the previous one through this single controller.
  const loadControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    try {
      const { deployments, scopeMissing } = await fetchDeployments({
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setDeployments(deployments);
      setScopeMissing(Boolean(scopeMissing));
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      // AbortError is expected when the next load() supersedes us.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(asMessage(err));
    }
  }, []);

  /**
   * Reload after the create form was unmounted with a POST in flight
   * (Cancel button, route change). The polling logic itself lives in
   * `pollDeploymentsForSlug` (`./Endpoints.helpers.ts`) so it can be
   * unit-tested without React; this wrapper just wires up the
   * AbortController and the React state setters. 6 attempts × 500 ms
   * ≈ 3 s — long enough for a reasonable server commit window, short
   * enough that a forgotten poll doesn't keep hammering the cloud API
   * forever.
   */
  const pollAfterAbortedCreate = useCallback(async (slug: string) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    await pollDeploymentsForSlug({
      slug,
      signal: controller.signal,
      fetchDeployments,
      onUpdate: ({ deployments, scopeMissing }) => {
        setDeployments(deployments);
        setScopeMissing(Boolean(scopeMissing));
        setError(null);
      },
      onError: (msg) => setError(msg),
    });
  }, []);

  useEffect(() => {
    void load();
    // The controller created by load() is closed when this effect tears
    // down (component unmount or `load` identity change), aborting any
    // still-in-flight fetch (or post-abort poll) so it can't setState
    // on an unmounted view.
    return () => {
      loadControllerRef.current?.abort();
    };
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Endpoints
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Dedicated <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">*.arkor.app</code>{" "}
            URLs that serve OpenAI-compatible chat completions for a chosen
            adapter or base model.
          </p>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "New endpoint"}
        </Button>
      </div>

      {showCreate && (
        <NewEndpointForm
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
          onMaybeCreated={(slug) => {
            // The form was unmounted (Cancel button, navigation) while a
            // POST was in flight. The server may already have committed
            // the row even though the client aborted, but the commit can
            // land a few hundred ms after our abort fires — a single
            // immediate reload would return the pre-create snapshot and
            // the user would still hit a confusing 409 on retry. Poll
            // for the specific slug (or give up after a few seconds).
            void pollAfterAbortedCreate(slug);
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Deployments</CardTitle>
          <CardDescription>
            Click a row to manage API keys and toggle settings.
          </CardDescription>
        </CardHeader>

        {error ? (
          <div className="px-6 py-4 text-sm text-red-600 dark:text-red-400">
            Failed to load endpoints: {error}
          </div>
        ) : deployments === null ? (
          <div className="space-y-3 px-6 py-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : deployments.length === 0 ? (
          // Two distinct empty states: "this project genuinely has no
          // deployments" vs "we don't know which project this Studio
          // session is scoped to (no `.arkor/state.json`)". The
          // unscoped branch covers three operator configurations and
          // each needs a different next step — anonymous (the create
          // path will bootstrap), Auth0 (must restore state.json), or
          // not-signed-in / autoAnonymous=false (must `arkor login`
          // first; the create attempt would otherwise 401 with a
          // hint that's identical to what we surface here). The list
          // route itself doesn't see the credentials state, so the
          // copy has to enumerate all three remediations rather than
          // single one out — the actual error you hit on the next
          // create attempt narrows it down.
          scopeMissing ? (
            <EmptyState
              icon={<Inbox />}
              title="Workspace not scoped to a project yet"
              description="The next endpoint create will bootstrap this for an anonymous session. If you're signed in with OAuth, restore .arkor/state.json by hand to point this Studio session at the project you want to manage. If neither applies (no credentials on disk), run `arkor login` first — Studio cannot reach the cloud API without one."
            />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="No endpoints yet"
              description="Create one to expose a model at https://<slug>.arkor.app/v1/chat/completions."
            />
          )
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {deployments.map((d) => (
              <li key={d.id}>
                <a
                  href={`#/endpoints/${encodeURIComponent(d.id)}`}
                  className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {d.slug}
                      <span className="text-zinc-400">.arkor.app</span>
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {describeTarget(d.target)} · auth: {d.authMode}
                    </span>
                  </div>
                  <span
                    className={
                      d.enabled
                        ? "rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300"
                        : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                    }
                  >
                    {d.enabled ? "enabled" : "disabled"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form (toggled inline from the list view)
// ---------------------------------------------------------------------------

type TargetMode = "adapter_final" | "adapter_checkpoint" | "base_model";

function NewEndpointForm({
  onCreated,
  onMaybeCreated,
}: {
  onCreated: () => void;
  onMaybeCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [authMode, setAuthMode] = useState<DeploymentAuthMode>("fixed_api_key");
  const [targetMode, setTargetMode] = useState<TargetMode>("adapter_final");
  const [jobId, setJobId] = useState("");
  const [step, setStep] = useState(0);
  const [baseModel, setBaseModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Abort the in-flight POST when the form unmounts (the parent's Cancel
  // toggle hides this component, route changes, etc.). Aborting only
  // stops the *client* from waiting; the server may already have
  // committed the row, so we tell the parent to refresh the list via
  // `onMaybeCreated` — otherwise the user clicks Cancel, retries with
  // the same slug, and sees a confusing 409 collision instead of the
  // row that was actually created. The slug we attempted is captured
  // in a ref so the unmount cleanup hands the parent the exact value
  // to poll for, regardless of what's still in the input box.
  //
  // Use refs (not closures) so the unmount cleanup sees the most recent
  // controller / "was a request in flight?" state without re-binding the
  // effect on every render.
  const submitControllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const inFlightSlugRef = useRef<string>("");
  const onMaybeCreatedRef = useRef(onMaybeCreated);
  onMaybeCreatedRef.current = onMaybeCreated;
  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        submitControllerRef.current?.abort();
        onMaybeCreatedRef.current(inFlightSlugRef.current);
      }
    };
  }, []);

  function buildTarget(): DeploymentTarget | null {
    if (targetMode === "base_model") {
      if (!baseModel.trim()) return null;
      return { kind: "base_model", baseModel: baseModel.trim() };
    }
    if (!jobId.trim()) return null;
    if (targetMode === "adapter_final") {
      return {
        kind: "adapter",
        adapter: { kind: "final", jobId: jobId.trim() },
      };
    }
    return {
      kind: "adapter",
      adapter: { kind: "checkpoint", jobId: jobId.trim(), step },
    };
  }

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const target = buildTarget();
    if (!target) {
      setError("Fill in the target details");
      return;
    }
    // Synchronous re-entrancy guard. `submitting` is React state and
    // doesn't render the submit disabled until the next tick, so a fast
    // double-click would otherwise abort the first POST and start a
    // second one. If the first POST has already committed server-side
    // by the time the abort arrives, the second submit gets a 409 for
    // a slug that *did* land — a confusing failure for an action the
    // user perceives as a single click.
    if (inFlightRef.current) return;
    const trimmedSlug = slug.trim();
    const body: CreateDeploymentBody = {
      slug: trimmedSlug,
      target,
      authMode,
    };
    const controller = new AbortController();
    submitControllerRef.current = controller;
    inFlightRef.current = true;
    inFlightSlugRef.current = trimmedSlug;
    setSubmitting(true);
    try {
      await createDeployment(body, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // Mark the request as completed *before* `onCreated()` runs.
      // `onCreated()` flips parent state that unmounts this form, and
      // depending on React batching the unmount cleanup may run before
      // we fall through to `finally` — which would see `inFlightRef`
      // still true, mistake a successful create for an aborted one, and
      // kick off the fallback poll on every successful submission.
      inFlightRef.current = false;
      onCreated();
    } catch (err) {
      // AbortError fires when the form unmounts mid-flight; the unmount
      // cleanup above is responsible for telling the parent to reload
      // via `onMaybeCreated` (the POST may already be committed). Don't
      // surface the abort as an error.
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(asMessage(err));
    } finally {
      // Belt and braces for the catch / early-return paths above. The
      // success path already cleared the flag before calling
      // `onCreated()`; this catches the cases where we never got there.
      inFlightRef.current = false;
      // Only clear `submitting` if we're still the active controller.
      // After abort the component is being torn down, so a setState would
      // either no-op (post-unmount) or fight a fresh submit attempt.
      if (submitControllerRef.current === controller) {
        setSubmitting(false);
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New endpoint</CardTitle>
        <CardDescription>
          Pick a slug, target, and auth mode. The endpoint becomes reachable at
          <code className="mx-1 rounded bg-zinc-100 px-1 dark:bg-zinc-900">
            https://&lt;slug&gt;.arkor.app/v1/chat/completions
          </code>
          once DNS propagates.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Slug
            </span>
            {/*
              The slug input intentionally drops its own focus ring
              (`focus-visible:outline-none`) so the suffix span stays
              flush with the input. The wrapper picks the focus ring
              up via `focus-within:*` so keyboard users still see a
              visible focus indicator on the whole control — without
              this they get *no* focus signal at all.
            */}
            <div className="mt-1 flex items-center rounded-lg border border-zinc-200 bg-white focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-500/30 dark:border-zinc-800 dark:bg-zinc-950">
              <input
                type="text"
                required
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                minLength={2}
                maxLength={50}
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="mymodel"
                className="flex-1 rounded-l-lg border-0 bg-transparent px-3 py-1.5 text-sm focus-visible:outline-none"
              />
              <span className="rounded-r-lg bg-zinc-50 px-3 py-1.5 text-sm text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                .arkor.app
              </span>
            </div>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Target
            </legend>
            <div className="flex flex-col gap-1 text-sm text-zinc-700 dark:text-zinc-300">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={targetMode === "adapter_final"}
                  onChange={() => setTargetMode("adapter_final")}
                />
                Job&apos;s final adapter
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={targetMode === "adapter_checkpoint"}
                  onChange={() => setTargetMode("adapter_checkpoint")}
                />
                Specific checkpoint
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="targetMode"
                  checked={targetMode === "base_model"}
                  onChange={() => setTargetMode("base_model")}
                />
                Base model only (no LoRA)
              </label>
            </div>
            {targetMode === "base_model" ? (
              <input
                type="text"
                required
                aria-label="Base model name"
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value)}
                placeholder="meta-llama/Llama-2-7b-hf"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              />
            ) : (
              <div className="mt-1 flex flex-col gap-2">
                <input
                  type="text"
                  required
                  aria-label="Job UUID"
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  placeholder="Job UUID"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-950"
                />
                {targetMode === "adapter_checkpoint" && (
                  <input
                    type="number"
                    required
                    min={0}
                    aria-label="Checkpoint step"
                    value={step}
                    onChange={(e) => setStep(Number(e.target.value))}
                    placeholder="Step"
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                  />
                )}
              </div>
            )}
          </fieldset>

          <label className="block">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Auth mode
            </span>
            <select
              value={authMode}
              onChange={(e) =>
                setAuthMode(e.target.value as DeploymentAuthMode)
              }
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="fixed_api_key">Fixed API key</option>
              <option value="none">No auth (public)</option>
            </select>
          </label>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create endpoint"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail view (per-endpoint URL preview, settings, key management)
// ---------------------------------------------------------------------------

export function EndpointDetail({ id }: { id: string }) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [keys, setKeys] = useState<DeploymentKey[] | null>(null);
  // Separate error tracks so a transient `/keys` failure doesn't black
  // out the URL / settings / delete controls for an endpoint that
  // actually exists. `error` is the deployment-fetch failure (gates the
  // whole page); `keysError` is the keys-fetch failure (shown inline in
  // the API keys card while the rest of the page stays usable).
  const [error, setError] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous mirror of `busy` so re-entrancy guards in `withBusy`
  // can fire inside the same task as the click that started a mutation
  // — the `busy` state itself only re-renders the controls disabled on
  // the next React tick, which is too late to block a fast double-click.
  const busyRef = useRef(false);
  const [revealed, setRevealed] = useState<CreatedDeploymentKey | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState("");

  // Per-`id` request guard. When the user navigates from endpoint A to
  // endpoint B quickly, the in-flight A fetch can settle after B's and
  // overwrite B's state — leaving the page showing A while every action
  // handler calls the API for B (the value of `id` from props). We tag
  // every load with the id it was started for and ignore results whose
  // tag no longer matches the current `id` prop.
  const activeIdRef = useRef(id);

  // Per-resource superseded flags. The initial mount fires
  // `fetchDeployment` and `fetchDeploymentKeys` in parallel. If the user
  // mutates either resource (toggle / delete / issue / revoke) before the
  // matching initial fetch resolves, the late-landing initial response
  // would otherwise overwrite the optimistic mutation result and leave
  // the UI showing the pre-mutation snapshot. Mutation handlers flip the
  // matching flag before calling setState; the initial-fetch `.then`s
  // bail when the flag is set. The flags are scoped per-resource so a
  // deployment mutation doesn't drop the in-flight keys load and vice
  // versa.
  const initialDeploymentSupersededRef = useRef(false);
  const initialKeysSupersededRef = useRef(false);

  // Track in-flight `createDeploymentKey` calls separately from the rest
  // of the mutations because the response carries the *one-time*
  // plaintext: if the user navigates away or closes the tab while it's
  // pending — or before they acknowledge the displayed plaintext — the
  // server may still commit the row but we lose the only chance to
  // surface the secret. Three layers of defence:
  //   1. `pendingKeyIssueRef` tracks "is there an un-recoverable secret
  //      to protect?" — true while the POST is in flight AND while the
  //      plaintext is on screen but not yet acknowledged. Used to gate
  //      the `beforeunload` warning and the navigation guard below.
  //   2. `keyPostInFlightRef` is the narrower flag — true only while
  //      the POST is *actively running*. Used to pick the right confirm
  //      copy ("being issued" vs "shown but not yet saved").
  //   3. `keyIssueControllerRef` lets the unmount cleanup abort the
  //      fetch (the server may still commit, in which case the orphan
  //      key shows up the next time the user opens this endpoint and is
  //      revocable from the list).
  const pendingKeyIssueRef = useRef(false);
  const keyPostInFlightRef = useRef(false);
  const keyIssueControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // The actual wiring (beforeunload listener, nav-guard registration,
    // unmount abort) lives in `setupKeyIssueGuards` so it can be
    // unit-tested without a DOM. Inject the side-effects through the
    // helper's options so tests can swap `window.confirm`,
    // `addEventListener`, etc. for stubs while still exercising the
    // same registration / cleanup ordering that runs in the browser.
    return setupKeyIssueGuards({
      isPending: () => pendingKeyIssueRef.current,
      isPostInFlight: () => keyPostInFlightRef.current,
      getKeyIssueController: () => keyIssueControllerRef.current,
      registerNavigationGuard,
      addBeforeUnloadListener: (h) =>
        window.addEventListener("beforeunload", h),
      removeBeforeUnloadListener: (h) =>
        window.removeEventListener("beforeunload", h),
      confirm: (msg) => window.confirm(msg),
      onAcceptedLoss: () => {
        pendingKeyIssueRef.current = false;
      },
    });
  }, []);

  useEffect(() => {
    // The `id` prop changed (or this is the first mount). Reset visible
    // state immediately so the previous endpoint's slug / keys / revealed
    // plaintext don't keep rendering while the new fetch is in flight.
    // Without this, a fast Delete / Enable / Revoke click can mutate the
    // *new* deployment while the UI still shows the *old* one.
    activeIdRef.current = id;
    initialDeploymentSupersededRef.current = false;
    initialKeysSupersededRef.current = false;
    setDeployment(null);
    setKeys(null);
    setError(null);
    setKeysError(null);
    setRevealed(null);
    // The plaintext from the previous endpoint (if any) has already been
    // accepted as lost by the user passing the navigation guard. Clear
    // the protection flag so it doesn't survive into this new endpoint.
    pendingKeyIssueRef.current = false;
    keyPostInFlightRef.current = false;
    // Crucially, abort any *in-flight* `createDeploymentKey` POST that
    // belonged to the previous endpoint. Without this the navigation
    // (e.g. `#/endpoints/A` → `#/endpoints/B`) leaves the request
    // running in the background; when it eventually succeeds, the
    // `activeIdRef` guard skips `setRevealed`, the one-time plaintext
    // is dropped on the floor, and the operator is left with an orphan
    // active key for endpoint A that they cannot see the secret of.
    // Aborting at least pushes the cancellation through the network
    // layer; if the server has already committed, the key still shows
    // up the next time the user opens A's detail page.
    keyIssueControllerRef.current?.abort();
    keyIssueControllerRef.current = null;
    setNewKeyLabel("");
    setBusy(false);
    busyRef.current = false;

    const controller = new AbortController();

    function isAbort(err: unknown): boolean {
      return err instanceof DOMException && err.name === "AbortError";
    }
    function stillActive(): boolean {
      return !controller.signal.aborted && activeIdRef.current === id;
    }

    // Fire both requests in parallel but resolve independently so a
    // transient `/keys` failure doesn't take the whole detail page
    // down with it. The deployment row drives the page (URL preview,
    // settings, delete); the key list is auxiliary and degrades to an
    // inline error in its own card.
    void fetchDeployment(id, { signal: controller.signal })
      .then(({ deployment }) => {
        if (!stillActive() || initialDeploymentSupersededRef.current) return;
        setDeployment(deployment);
      })
      .catch((err: unknown) => {
        if (!stillActive() || initialDeploymentSupersededRef.current) return;
        if (isAbort(err)) return;
        setError(asMessage(err));
      });

    void fetchDeploymentKeys(id, { signal: controller.signal })
      .then(({ keys }) => {
        if (!stillActive() || initialKeysSupersededRef.current) return;
        setKeys(keys);
      })
      .catch((err: unknown) => {
        if (!stillActive() || initialKeysSupersededRef.current) return;
        if (isAbort(err)) return;
        setKeysError(asMessage(err));
      });

    return () => {
      // Effect cleanup runs on every `id` change AND on unmount. Abort
      // the in-flight requests so the network layer drops the response
      // and the load doesn't even attempt to call setState for a stale
      // deployment.
      controller.abort();
    };
  }, [id]);


  /**
   * Wrap a mutation so a slow API call that resolves after the user has
   * navigated to a different endpoint doesn't apply its result to the
   * new endpoint's state. The pattern: capture the id-at-call-time, run
   * the mutation, and only commit the optimistic state update if the
   * page is still showing the same endpoint when the response lands.
   *
   * `busyRef` is a synchronous mirror of the `busy` React state. We
   * gate re-entry on the *ref*, not the state — `setBusy(true)` only
   * re-renders on the next tick, so two clicks that fire inside the
   * same task (a fast double-click on Delete, a quick auth-mode select
   * change) would both see `busy === false` and run concurrently. The
   * second response's `setDeployment` could then clobber the first's,
   * leaving the UI in a state that disagrees with the cloud's record.
   */
  async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    const myId = id;
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (activeIdRef.current !== myId) return undefined;
      return result;
    } catch (err) {
      if (activeIdRef.current !== myId) return undefined;
      setError(asMessage(err));
      return undefined;
    } finally {
      // Always release the synchronous ref, even when the user has
      // navigated away — otherwise the *next* endpoint's first
      // mutation would think a request is already in flight and
      // silently no-op.
      busyRef.current = false;
      // Only clear `busy` if we're still on the endpoint that started
      // this mutation. Without the guard, a long-running A-mutation
      // settling after the user has navigated to B would flip B's busy
      // flag back to false while B's own request might still be in
      // flight, re-enabling its controls and allowing duplicate
      // enable/delete/revoke clicks. The B-side `withBusy` runs its own
      // setBusy(true)/setBusy(false) cycle for that request, so leaving
      // A's stale finally as a no-op is safe; the per-id useEffect
      // above also resets `busy` on the next id change.
      if (activeIdRef.current === myId) setBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!deployment) return;
    const myId = id;
    await withBusy(async () => {
      const { deployment: updated } = await updateDeployment(myId, {
        enabled: !deployment.enabled,
      });
      if (activeIdRef.current === myId) {
        // Mark the in-flight initial deployment fetch as superseded so
        // a slow initial response can't land after this mutation and
        // overwrite our fresh value with the pre-toggle snapshot.
        initialDeploymentSupersededRef.current = true;
        setDeployment(updated);
      }
    });
  }

  async function changeAuthMode(mode: DeploymentAuthMode) {
    const myId = id;
    await withBusy(async () => {
      const { deployment: updated } = await updateDeployment(myId, {
        authMode: mode,
      });
      if (activeIdRef.current === myId) {
        initialDeploymentSupersededRef.current = true;
        setDeployment(updated);
      }
    });
  }

  async function onDelete() {
    if (!deployment) return;
    // If a one-time plaintext is on screen, fold the warning into the
    // delete confirm rather than two-step prompting after the delete
    // already succeeded. Without this, the post-delete redirect would
    // trip the navigation guard, the user would Cancel to keep the
    // secret, and we'd be stuck on a stale detail view for a deployment
    // that no longer exists server-side.
    const message = revealed
      ? `Delete endpoint ${deployment.slug}.arkor.app? The just-issued API key plaintext on screen will also be lost — copy it first if you still need it.`
      : `Delete endpoint ${deployment.slug}.arkor.app?`;
    if (!window.confirm(message)) return;
    const myId = id;
    const ok = await withBusy(async () => {
      await deleteDeployment(myId);
      return true;
    });
    if (ok && activeIdRef.current === myId) {
      // The deployment (and its keys, server-side) are gone. Release the
      // navigation guard before redirecting so the post-delete hash
      // change doesn't prompt a second confirm for a secret that's now
      // moot.
      pendingKeyIssueRef.current = false;
      // Roll the user back to the list view they came from instead of
      // replacing-in-place. A plain `navigateReplace("#/endpoints")`
      // would leave the user with a stack that *also* has the original
      // list entry at the previous step, so their first Back press
      // would land on the same `#/endpoints` URL and appear to do
      // nothing. `navigateBackOr` undoes the list→detail navigation
      // when there's a previous in-document entry, and falls back to
      // replace when this was a direct-link load.
      navigateBackOr("#/endpoints");
    }
  }

  /**
   * Re-fetch the key list and reconcile state after a mutation. Only
   * meaningful when the initial `/keys` load failed (`keys === null` and
   * `keysError !== null`): a successful issue / revoke happens against
   * the cloud's full list, and the optimistic local-only update would
   * otherwise wipe pre-existing keys from view (operators couldn't audit
   * or revoke them after a transient load failure). When the initial
   * load succeeded, the in-memory list is authoritative and we let the
   * optimistic update stand.
   */
  async function refreshKeysIfStale(myId: string): Promise<void> {
    if (keys !== null) return;
    try {
      const { keys: fresh } = await fetchDeploymentKeys(myId);
      if (activeIdRef.current !== myId) return;
      setKeys(fresh);
      setKeysError(null);
    } catch (err) {
      if (activeIdRef.current !== myId) return;
      // Keep the prior `keysError` visible if the refetch also fails.
      setKeysError(asMessage(err));
    }
  }

  async function onCreateKey(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const label = newKeyLabel.trim();
    if (!label) return;
    const myId = id;
    await withBusy(async () => {
      // Mark the issue as in flight so the `beforeunload` listener
      // (set up in the unmount-cleanup useEffect above) confirms before
      // a tab close that would drop the one-time plaintext.
      keyIssueControllerRef.current?.abort();
      const controller = new AbortController();
      keyIssueControllerRef.current = controller;
      pendingKeyIssueRef.current = true;
      keyPostInFlightRef.current = true;
      let succeeded = false;
      try {
        const { key } = await createDeploymentKey(
          myId,
          { label },
          { signal: controller.signal },
        );
        if (activeIdRef.current !== myId) return;
        setRevealed(key);
        setNewKeyLabel("");
        succeeded = true;
        // Drop any in-flight initial keys fetch so it can't land later
        // and overwrite the just-issued / refreshed list.
        initialKeysSupersededRef.current = true;
        if (keys === null) {
          // Initial load failed; optimistically appending to `[]` would
          // hide every pre-existing key. Re-fetch the canonical list.
          await refreshKeysIfStale(myId);
        } else {
          setKeys([
            ...keys,
            {
              id: key.id,
              label: key.label,
              prefix: key.prefix,
              enabled: true,
              createdAt: key.createdAt,
              lastUsedAt: null,
            },
          ]);
        }
      } finally {
        // Only release the shared protection flags if we are STILL the
        // active key-issue request. The per-id useEffect (after the
        // user navigated A→B) or a fresh submit on this page would
        // have replaced `keyIssueControllerRef.current` with a newer
        // controller; in that case our finally is unwinding a
        // superseded request and must NOT touch the shared state — B's
        // own `onCreateKey` already set `keyPostInFlightRef = true` /
        // `pendingKeyIssueRef = true`, and clearing them here would
        // silently drop B's beforeunload + hash-navigation guard.
        if (keyIssueControllerRef.current === controller) {
          // The POST is no longer running regardless of outcome —
          // switch the confirm-copy ref so any subsequent nav guard
          // prompts use the "shown on screen" wording rather than
          // "being issued".
          keyPostInFlightRef.current = false;
          // On *failure* clear the protection flag so the next tab
          // close / nav doesn't get a stale confirm dialog. On
          // *success* keep it true: the plaintext is now on screen
          // but un-recoverable, so the same nav guard that protected
          // the in-flight POST must keep protecting the displayed key
          // until the user clicks "I've saved it" (`dismissRevealed`
          // below clears the flag at that moment).
          if (!succeeded) {
            pendingKeyIssueRef.current = false;
          }
          keyIssueControllerRef.current = null;
        }
      }
    });
  }

  /**
   * Clear the displayed plaintext after the operator has copied it.
   * Also releases the navigation guard, since there is no longer any
   * un-recoverable secret on screen to protect.
   */
  function dismissRevealed() {
    pendingKeyIssueRef.current = false;
    setRevealed(null);
  }

  async function onRevoke(keyId: string) {
    if (!window.confirm("Revoke this key?")) return;
    const myId = id;
    await withBusy(async () => {
      await revokeDeploymentKey(myId, keyId);
      if (activeIdRef.current !== myId) return;
      // Same supersede guard as create: a slow initial /keys fetch
      // landing after this revoke would otherwise re-show the key as
      // enabled until the next reload.
      initialKeysSupersededRef.current = true;
      if (keys === null) {
        // Same hazard as above: marking just this key as disabled would
        // imply an empty rest-of-the-list. Re-fetch instead.
        await refreshKeysIfStale(myId);
      } else {
        setKeys(
          keys.map((k) =>
            k.id === keyId ? { ...k, enabled: false } : k,
          ),
        );
      }
    });
  }

  if (error && !deployment) {
    return (
      <div className="space-y-6">
        <a
          href="#/endpoints"
          className="text-sm text-teal-600 hover:underline dark:text-teal-400"
        >
          ← Back to endpoints
        </a>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!deployment) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const url = deploymentUrl(deployment.slug);

  return (
    <div className="space-y-8">
      <a
        href="#/endpoints"
        className="inline-block text-sm text-teal-600 hover:underline dark:text-teal-400"
      >
        ← Back to endpoints
      </a>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {deployment.slug}
            <span className="text-zinc-400">.arkor.app</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {describeTarget(deployment.target)}
          </p>
        </div>
        <Button variant="danger" onClick={onDelete} disabled={busy}>
          Delete
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Endpoint URL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs break-all dark:bg-zinc-900">
              {url}
            </code>
            <CopyButton value={url} />
          </div>
        </CardContent>
      </Card>

      <QuickStart endpointUrl={url} authMode={deployment.authMode} />

      <Card>
        <CardHeader
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={toggleEnabled}
              disabled={busy}
            >
              {deployment.enabled ? "Disable" : "Enable"}
            </Button>
          }
        >
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Auth mode
            </span>
            <select
              value={deployment.authMode}
              onChange={(e) =>
                void changeAuthMode(e.target.value as DeploymentAuthMode)
              }
              disabled={busy}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="fixed_api_key">Fixed API key</option>
              <option value="none">No auth (public)</option>
            </select>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          {deployment.authMode === "none" && (
            <CardDescription>
              Auth is set to <strong>none</strong>; keys are not enforced.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreateKey} className="mb-4 flex items-center gap-2">
            <input
              type="text"
              aria-label="API key label"
              value={newKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
              placeholder="Label (e.g. production)"
              maxLength={80}
              // The plaintext for an already-issued key is held in
              // `revealed` and is one-time. Re-enabling this input while
              // it's on screen would let a second `Issue key` overwrite
              // `revealed`, permanently losing the first key's secret
              // even though that key remains active server-side. Keep
              // both the input and the submit disabled until the
              // operator acknowledges with "I've saved it".
              disabled={busy || revealed !== null}
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
            />
            <Button
              type="submit"
              disabled={busy || revealed !== null || !newKeyLabel.trim()}
            >
              Issue key
            </Button>
          </form>

          {revealed && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700/50 dark:bg-amber-900/20">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                Copy this key now — it cannot be shown again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-zinc-950">
                  {revealed.plaintext}
                </code>
                <CopyButton value={revealed.plaintext} />
              </div>
              <button
                type="button"
                onClick={dismissRevealed}
                className="mt-2 text-xs text-amber-900 underline dark:text-amber-300"
              >
                I&apos;ve saved it
              </button>
            </div>
          )}

          {keysError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
              Failed to load keys: {keysError}
            </p>
          ) : keys === null ? (
            <Skeleton className="h-10 w-full" />
          ) : keys.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No keys yet.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div>
                    <p
                      className={
                        k.enabled
                          ? "font-medium text-zinc-900 dark:text-zinc-100"
                          : "font-medium text-zinc-400 line-through"
                      }
                    >
                      {k.label}
                    </p>
                    <p className="font-mono text-xs text-zinc-500">
                      {k.prefix}…
                    </p>
                  </div>
                  {k.enabled && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onRevoke(k.id)}
                      disabled={busy}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
