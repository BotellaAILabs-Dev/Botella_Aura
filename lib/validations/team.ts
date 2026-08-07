import { z } from 'zod';
import { emailSchema } from '@/lib/validations/auth';

/** Roles that can be assigned via the UI (OWNER handled with extra guards). */
export const assignableRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: assignableRoleSchema.default('MEMBER'),
});

export const updateRoleSchema = z.object({
  role: assignableRoleSchema,
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
