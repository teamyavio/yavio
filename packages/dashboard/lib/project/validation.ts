import { ProjectSlug } from "@yavio/shared/validation";
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  slug: ProjectSlug.optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  slug: ProjectSlug.optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
