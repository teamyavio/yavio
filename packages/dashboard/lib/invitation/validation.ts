import { WorkspaceRole } from "@yavio/shared/validation";
import { z } from "zod";

export const inviteSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: WorkspaceRole.exclude(["owner"]),
});

export type InviteInput = z.infer<typeof inviteSchema>;
