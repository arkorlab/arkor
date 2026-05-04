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
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const { deployments } = await fetchDeployments();
      setDeployments(deployments);
      setError(null);
    } catch (err) {
      setError(asMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
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
          <EmptyState
            icon={<Inbox />}
            title="No endpoints yet"
            description="Create one to expose a model at https://<slug>.arkor.app/v1/chat/completions."
          />
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

function NewEndpointForm({ onCreated }: { onCreated: () => void }) {
  const [slug, setSlug] = useState("");
  const [authMode, setAuthMode] = useState<DeploymentAuthMode>("fixed_api_key");
  const [targetMode, setTargetMode] = useState<TargetMode>("adapter_final");
  const [jobId, setJobId] = useState("");
  const [step, setStep] = useState(0);
  const [baseModel, setBaseModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const body: CreateDeploymentBody = { slug: slug.trim(), target, authMode };
    setSubmitting(true);
    try {
      await createDeployment(body);
      onCreated();
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setSubmitting(false);
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
            <div className="mt-1 flex items-center rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
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
  const [revealed, setRevealed] = useState<CreatedDeploymentKey | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState("");

  // Per-`id` request guard. When the user navigates from endpoint A to
  // endpoint B quickly, the in-flight A fetch can settle after B's and
  // overwrite B's state — leaving the page showing A while every action
  // handler calls the API for B (the value of `id` from props). We tag
  // every load with the id it was started for and ignore results whose
  // tag no longer matches the current `id` prop.
  const activeIdRef = useRef(id);

  useEffect(() => {
    // The `id` prop changed (or this is the first mount). Reset visible
    // state immediately so the previous endpoint's slug / keys / revealed
    // plaintext don't keep rendering while the new fetch is in flight.
    // Without this, a fast Delete / Enable / Revoke click can mutate the
    // *new* deployment while the UI still shows the *old* one.
    activeIdRef.current = id;
    setDeployment(null);
    setKeys(null);
    setError(null);
    setKeysError(null);
    setRevealed(null);
    setNewKeyLabel("");
    setBusy(false);

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
        if (!stillActive()) return;
        setDeployment(deployment);
      })
      .catch((err: unknown) => {
        if (!stillActive() || isAbort(err)) return;
        setError(asMessage(err));
      });

    void fetchDeploymentKeys(id, { signal: controller.signal })
      .then(({ keys }) => {
        if (!stillActive()) return;
        setKeys(keys);
      })
      .catch((err: unknown) => {
        if (!stillActive() || isAbort(err)) return;
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
   */
  async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
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
      if (activeIdRef.current === myId) setDeployment(updated);
    });
  }

  async function changeAuthMode(mode: DeploymentAuthMode) {
    const myId = id;
    await withBusy(async () => {
      const { deployment: updated } = await updateDeployment(myId, {
        authMode: mode,
      });
      if (activeIdRef.current === myId) setDeployment(updated);
    });
  }

  async function onDelete() {
    if (!deployment) return;
    if (
      !window.confirm(`Delete endpoint ${deployment.slug}.arkor.app?`)
    ) {
      return;
    }
    const myId = id;
    const ok = await withBusy(async () => {
      await deleteDeployment(myId);
      return true;
    });
    if (ok && activeIdRef.current === myId) {
      window.location.hash = "#/endpoints";
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
      const { key } = await createDeploymentKey(myId, { label });
      if (activeIdRef.current !== myId) return;
      setRevealed(key);
      setNewKeyLabel("");
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
    });
  }

  async function onRevoke(keyId: string) {
    if (!window.confirm("Revoke this key?")) return;
    const myId = id;
    await withBusy(async () => {
      await revokeDeploymentKey(myId, keyId);
      if (activeIdRef.current !== myId) return;
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
              value={newKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
              placeholder="Label (e.g. production)"
              maxLength={80}
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
            <Button type="submit" disabled={busy || !newKeyLabel.trim()}>
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
                onClick={() => setRevealed(null)}
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
