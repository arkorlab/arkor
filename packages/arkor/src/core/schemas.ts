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
