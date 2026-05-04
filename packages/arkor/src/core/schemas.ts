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
 * Field-level shape is matched at the TS-type layer (see
 * `core/deployments.ts`); the runtime parse here only validates the wrapper
 * envelope so the SDK can throw a clear error when control-plane returns an
 * unexpected response (e.g. a stray HTML 502 page from a CDN in front).
 */
const deploymentSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  orgId: z.string(),
  projectId: z.string(),
});
const deploymentKeySchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  prefix: z.string(),
});
const createKeyEnvelopeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  plaintext: z.string(),
  prefix: z.string(),
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
