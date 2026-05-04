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
const deploymentTargetSchema = z.union([
  z.looseObject({
    kind: z.literal("adapter"),
    adapter: z.looseObject({
      kind: z.enum(["final", "checkpoint"]),
      jobId: z.string(),
    }),
  }),
  z.looseObject({
    kind: z.literal("base_model"),
    baseModel: z.string(),
  }),
]);

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
  runRetentionMode: z.enum(["unlimited", "disabled", "days"]).optional(),
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

const deploymentKeySchema = z.looseObject({
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
