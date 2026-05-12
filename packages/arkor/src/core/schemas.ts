import { z } from "zod";

/**
 * Tolerant ISO-8601 coercion for timestamp fields on the wire. The
 * cloud API serializes timestamps as ISO strings, but tests / mocks /
 * future producers may hand a `Date` to the decoder. A naive
 * `String(date)` returns the locale-ish form (e.g. `"Tue May 12 …"`),
 * so we normalise via `toISOString()` to keep the public DTO contract
 * actually ISO. Strings pass through verbatim (the cloud API is the
 * canonical source of truth for their format — we don't re-parse).
 */
function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/** Same as `toIso`, but for fields where `null` / `undefined` means "absent". */
function toIsoOrNull(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return toIso(v);
}

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
  createdAt: z.union([z.string(), z.date()]).transform(toIso),
  startedAt: z.union([z.string(), z.date()]).nullish().transform(toIsoOrNull),
  completedAt: z.union([z.string(), z.date()]).nullish().transform(toIsoOrNull),
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
export const createDeploymentRequestSchema = z
  .looseObject({
    slug: z
      .string()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
        message:
          "slug must be 2-50 chars, lowercase letters / digits / hyphens, starting and ending with a letter or digit (e.g. \"my-model\")",
      }),
    target: deploymentTargetSchema,
    authMode: z.enum(["none", "fixed_api_key"]),
    // The retention fields are a discriminated coupling: `days` mode
    // requires a positive integer `runRetentionDays`, the other modes
    // forbid it (and unset omits both). Mirroring the SDK's closed
    // enum here is intentional — Studio constructs these bodies, not
    // arbitrary clients, so unknown modes would already be a Studio
    // bug. The response decoder (`deploymentSchema` below) stays
    // open-enum so a future server-side addition flows through to
    // the SPA without a synchronous SDK release.
    runRetentionMode: z
      .enum(["unlimited", "disabled", "days"])
      .optional(),
    runRetentionDays: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    // `runRetentionDays` is meaningful only with mode `days`, and
    // mode `days` requires it. Catching both shapes here keeps a
    // malformed body from entering `withDeploymentClient("create")`'s
    // bootstrap branch on a fresh anonymous workspace.
    if (
      data.runRetentionDays !== undefined &&
      data.runRetentionMode !== "days"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runRetentionDays"],
        message:
          "runRetentionDays is only valid when runRetentionMode is \"days\".",
      });
    }
    if (
      data.runRetentionMode === "days" &&
      data.runRetentionDays === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runRetentionDays"],
        message:
          "runRetentionMode \"days\" requires a positive integer runRetentionDays.",
      });
    }
  });

/**
 * Local pre-validator for `POST /api/deployments/:id/keys` bodies in
 * `studio/server.ts`. The cloud API ultimately validates `label` server
 * side, but proxying obviously bad inputs (missing label, empty
 * string, wrong type, oversize) lets `withDeploymentClient("mutate")`
 * round-trip just to reject. Catching the easy mistakes locally keeps
 * the error close to the input and the response shape honest (the
 * "must include a `label` string" copy in the 400 only fires when
 * that's actually true).
 *
 * Length cap matches the public docs (1-80 chars after trim) and the
 * cloud-api Zod schema; trimming on the way in mirrors how the SPA
 * already trims `newKeyLabel` before submit.
 */
export const createDeploymentKeyRequestSchema = z.looseObject({
  label: z.string().trim().min(1).max(80),
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
  // Retention fields are optional on the wire — treat them as such.
  // `runRetentionMode` is parsed as a plain string rather than a closed
  // enum so an older SDK does not refuse to decode the response when the
  // control plane introduces a new mode (e.g. `"hours"`). The public DTO
  // type narrows the documented values for autocomplete via the
  // `(string & {})` open-enum trick — see DeploymentRunRetentionMode in
  // ./deployments.ts.
  runRetentionMode: z.string().optional(),
  runRetentionDays: z.number().optional(),
  // Cloud API serializes timestamps as ISO strings; we accept Date too
  // for parity with `trainingJobSchema`'s tolerant transform. `toIso`
  // normalises a `Date` via `toISOString()` (not the locale-ish
  // `String(date)` form) to keep the public DTO contract actually ISO.
  createdAt: z.union([z.string(), z.date()]).transform(toIso),
  updatedAt: z.union([z.string(), z.date()]).transform(toIso),
});

const deploymentKeySchema = z
  .looseObject({
    id: z.string(),
    label: z.string(),
    prefix: z.string(),
    enabled: z.boolean(),
    createdAt: z.union([z.string(), z.date()]).transform(toIso),
    // `lastUsedAt` is updated best-effort by the edge service; null until
    // the first authenticated request lands on the key.
    lastUsedAt: z
      .union([z.string(), z.date()])
      .nullish()
      .transform(toIsoOrNull),
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
  createdAt: z.union([z.string(), z.date()]).transform(toIso),
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
