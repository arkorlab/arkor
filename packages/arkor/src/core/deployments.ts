/**
 * Public types for the Arkor inference-deployment API surface.
 *
 * Mirrors the cloud `/v1/endpoints/*` schemas structurally but is declared
 * locally so this submodule has zero `@orbit/*` import surface (the OSS
 * tarball must not carry orbit-side names — see the leak grep wired into
 * `arkor-cloud-api-client`'s release preflight).
 *
 * Runtime parsing of server responses lives in `schemas.ts` as `z.looseObject`
 * — fields the server adds in the future will pass through unchanged.
 */

/**
 * What a deployment serves under its `<slug>.arkor.app` URL. Currently a
 * trained adapter (final or a specific checkpoint) or a raw base model.
 * Re-targetable via PATCH on the deployment's `target` field.
 */
export type DeploymentTarget =
  | {
      kind: "adapter";
      adapter:
        | { kind: "final"; jobId: string }
        | { kind: "checkpoint"; jobId: string; step: number };
    }
  | { kind: "base_model"; baseModel: string };

/**
 * - `none`: the URL is open (use only for demos / public models).
 * - `fixed_api_key`: requests must carry a valid deployment-issued key in
 *   `Authorization: Bearer …` or `x-api-key`. Issue keys via
 *   `createDeploymentKey`.
 */
export type DeploymentAuthMode = "none" | "fixed_api_key";

/**
 * How long to retain stored chat-completion runs for this deployment.
 * - `unlimited`: keep forever (operator opts into indefinite raw-chat storage).
 * - `disabled`: don't persist runs at all.
 * - `days`: keep for `runRetentionDays` days, then sweep.
 *
 * `runRetentionDays` is required (and must be ≥ 1) when mode is `"days"` and
 * is meaningless otherwise. Omitting both fields uses the server defaults
 * (`days` + 7).
 */
export type DeploymentRunRetentionMode = "unlimited" | "disabled" | "days";

/** A deployment row as returned by `getDeployment` / `listDeployments`. */
export interface DeploymentDto {
  id: string;
  slug: string;
  orgId: string;
  projectId: string;
  target: DeploymentTarget;
  authMode: DeploymentAuthMode;
  /** Currently always `"openai_compat"`; reserved for future native formats. */
  urlFormat: "openai_compat";
  enabled: boolean;
  /** Reserved for future custom-domain support — `null` for now. */
  customDomain: string | null;
  runRetentionMode?: DeploymentRunRetentionMode;
  runRetentionDays?: number;
  createdAt: string;
  updatedAt: string;
}

/** A key row as returned by `listDeploymentKeys` (no plaintext). */
export interface DeploymentKeyDto {
  id: string;
  label: string;
  /** Display-only first ~12 chars of the plaintext (e.g. `"ark_live_abcd1234"`). */
  prefix: string;
  /** A revoked key has `enabled: false`. */
  enabled: boolean;
  createdAt: string;
  /** Updated by the edge service ~best-effort on each authenticated request. */
  lastUsedAt: string | null;
}

/** Body for `createDeployment`. */
export interface CreateDeploymentInput {
  /**
   * Subdomain label. 2–50 chars, `[a-z0-9][a-z0-9-]*[a-z0-9]`. Reserved labels
   * (`www`, `api`, `admin`, …) are rejected by the server.
   */
  slug: string;
  target: DeploymentTarget;
  authMode: DeploymentAuthMode;
  runRetentionMode?: DeploymentRunRetentionMode;
  runRetentionDays?: number;
}

/** Partial update for `updateDeployment`. Any field omitted is left untouched. */
export interface UpdateDeploymentInput {
  target?: DeploymentTarget;
  authMode?: DeploymentAuthMode;
  enabled?: boolean;
  runRetentionMode?: DeploymentRunRetentionMode;
  runRetentionDays?: number;
}

/** Body for `createDeploymentKey`. */
export interface CreateDeploymentKeyInput {
  /** Human-readable label, 1–80 chars (e.g. `"production"`, `"staging"`). */
  label: string;
}

/**
 * Response from `createDeploymentKey`. The `plaintext` field is the **only**
 * time the server returns the raw key — store it immediately; subsequent
 * `listDeploymentKeys` calls only return the label + display prefix.
 */
export interface CreateDeploymentKeyResult {
  id: string;
  label: string;
  /** Full plaintext key. Returned exactly once on creation. */
  plaintext: string;
  prefix: string;
  createdAt: string;
}

/** Scope identifier for every deployment-related API call. */
export interface DeploymentScope {
  orgSlug: string;
  projectSlug: string;
}
