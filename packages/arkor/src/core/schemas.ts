import { z } from "zod";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const trainingJobSchema = z.looseObject({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: jobStatusSchema,
  config: z.looseObject({ model: z.string() }),
  error: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]).transform((v) => String(v)),
  startedAt: z.union([z.string(), z.date()]).nullish().transform((v) => (v ? String(v) : null)),
  completedAt: z.union([z.string(), z.date()]).nullish().transform((v) => (v ? String(v) : null)),
});

export const jobDetailResponseSchema = z.object({
  job: trainingJobSchema,
  events: z.array(z.looseObject({})).optional(),
});

export const anonymousTokenResponseSchema = z.object({
  token: z.string(),
  anonymousId: z.string(),
  kind: z.enum(["cli", "web"]),
  personalOrg: z.looseObject({ slug: z.string(), id: z.string(), name: z.string() }),
});

export const projectSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  orgId: z.string(),
});

export const createProjectResponseSchema = z.object({ project: projectSchema });
export const listProjectsResponseSchema = z.object({
  org: z.looseObject({ slug: z.string() }),
  projects: z.array(projectSchema),
});
export const createJobResponseSchema = z.object({ job: trainingJobSchema });

/**
 * Deployment response schemas. Use `looseObject` so a future server-side
 * field addition (e.g. a new retention mode, a `customDomain` value, etc.)
 * doesn't break installed SDK versions that haven't been re-published.
 *
 * Required fields here mirror every field declared as required in the
 * exported `DeploymentDto` / `DeploymentKeyDto` / `CreateDeploymentKeyResult`
 * TS interfaces (see `core/deployments.ts`). Without that parity an
 * upstream that drops a field would `decode()` cleanly while the SDK then
 * hands callers an object that violates its declared type contract.
 *
 * Inner shapes (`target`, retention enums) are kept structurally loose
 * because the inner-discriminator validation is done at the cloud-api
 * boundary; we just want to assert presence + primitive type here.
 */
// Inner adapter discriminator. Splitting `final` and `checkpoint` into
// separate branches lets us require `step` only on the checkpoint side
// (the exported `DeploymentTarget` declares `step: number` for that
// variant, so a server response missing `step` would otherwise produce
// a type-unsound DTO that downstream code dereferences as `undefined`).
const adapterRefSchema = z.union([
  z.looseObject({
    kind: z.literal("final"),
    jobId: z.string(),
  }),
  z.looseObject({
    kind: z.literal("checkpoint"),
    jobId: z.string(),
    step: z.number(),
  }),
]);

const deploymentTargetSchema = z.union([
  z.looseObject({
    kind: z.literal("adapter"),
    adapter: adapterRefSchema,
  }),
  z.looseObject({
    kind: z.literal("base_model"),
    baseModel: z.string(),
  }),
]);

/**
 * Request-body schema for `POST /v1/endpoints` (and Studio's
 * `POST /api/deployments` proxy). Used by Studio to gate the
 * scope-bootstrap branch *before* `ensureProjectState()` runs — a
 * malformed body that the cloud API would 400 anyway must NOT cause
 * an `.arkor/state.json` write or a remote project create on a fresh
 * anonymous workspace as a side effect.
 *
 * `slug` validation matches the cloud API's pattern (2–50 chars,
 * `[a-z0-9][a-z0-9-]*[a-z0-9]`) so the cheap shape check here also
 * catches the easy mistakes (empty / wrong-case / leading-dash) that
 * would otherwise reach the bootstrap path.
 */
export const createDeploymentRequestSchema = z.looseObject({
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  target: deploymentTargetSchema,
  authMode: z.enum(["none", "fixed_api_key"]),
  // Server-defaulted; Studio accepts but doesn't construct these.
  // Keep as `unknown` rather than re-implementing the discriminated
  // union here so a future server-side addition (`hours`, etc.) flows
  // through without a synchronous SDK update.
  runRetentionMode: z.unknown().optional(),
  runRetentionDays: z.number().optional(),
});

const deploymentSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  target: deploymentTargetSchema,
  authMode: z.enum(["none", "fixed_api_key"]),
  urlFormat: z.literal("openai_compat"),
  enabled: z.boolean(),
  customDomain: z.string().nullable(),
  // Retention fields are optional in the shared schema (see
  // packages/shared/src/schemas/deployments.ts) — treat them as such.
  // `runRetentionMode` is parsed as a plain string rather than a closed
  // enum so an older SDK does not refuse to decode the response when the
  // control plane introduces a new mode (e.g. `"hours"`). The public DTO
  // type narrows the documented values for autocomplete via the
  // `(string & {})` open-enum trick — see DeploymentRunRetentionMode in
  // ./deployments.ts.
  runRetentionMode: z.string().optional(),
  runRetentionDays: z.number().optional(),
  // Cloud API serializes timestamps as ISO strings; we accept Date too
  // for parity with `trainingJobSchema`'s tolerant transform.
  createdAt: z
    .union([z.string(), z.date()])
    .transform((v) => String(v)),
  updatedAt: z
    .union([z.string(), z.date()])
    .transform((v) => String(v)),
});

const deploymentKeySchema = z
  .looseObject({
    id: z.string(),
    label: z.string(),
    prefix: z.string(),
    enabled: z.boolean(),
    createdAt: z
      .union([z.string(), z.date()])
      .transform((v) => String(v)),
    // `lastUsedAt` is updated best-effort by the edge service; null until
    // the first authenticated request lands on the key.
    lastUsedAt: z
      .union([z.string(), z.date()])
      .nullish()
      .transform((v) => (v ? String(v) : null)),
  })
  // List-keys responses are documented as the no-plaintext shape
  // (plaintext is only ever returned from the create-key envelope, exactly
  // once on issue). `looseObject` would otherwise pass an unexpected
  // `plaintext` field straight through if the control plane regressed,
  // and the SDK type contract (`DeploymentKeyDto` has no `plaintext`)
  // would silently leak the secret to callers. Strip it defensively.
  .transform((entry) => {
    if ("plaintext" in entry) {
      // Mutate the parsed object instead of spreading: `looseObject` keeps
      // the `passthrough` proxy around unknown keys, and a spread would
      // both copy the field through and lose the type narrowing.
      delete (entry as { plaintext?: unknown }).plaintext;
    }
    return entry;
  });

const createKeyEnvelopeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  plaintext: z.string(),
  prefix: z.string(),
  createdAt: z
    .union([z.string(), z.date()])
    .transform((v) => String(v)),
});

export const getDeploymentResponseSchema = z.object({
  deployment: deploymentSchema,
});
export const createDeploymentResponseSchema = z.object({
  deployment: deploymentSchema,
});
export const updateDeploymentResponseSchema = z.object({
  deployment: deploymentSchema,
});
export const listDeploymentsResponseSchema = z.object({
  deployments: z.array(deploymentSchema),
});
export const listDeploymentKeysResponseSchema = z.object({
  keys: z.array(deploymentKeySchema),
});
export const createDeploymentKeyResponseSchema = z.object({
  key: createKeyEnvelopeSchema,
});
