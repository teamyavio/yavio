import { z } from "zod";

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const rotateApiKeySchema = z.object({
  gracePeriodMinutes: z.number().int().min(0).max(1440).optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>;
