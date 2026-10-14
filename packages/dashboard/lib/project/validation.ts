import { ProjectSlug } from "@yavio/shared/validation";
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  slug: ProjectSlug.optional(),
});

/**
 * Months of raw events a project keeps (#93). 13 is the platform window; at
 * least 2, because the statistics job recomputes the previous month daily.
 * Postgres enforces the same range (projects_retention_months_range).
 */
export const RETENTION_MONTHS_MIN = 2;
export const RETENTION_MONTHS_MAX = 13;

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  slug: ProjectSlug.optional(),
  retentionMonths: z.number().int().min(RETENTION_MONTHS_MIN).max(RETENTION_MONTHS_MAX).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
