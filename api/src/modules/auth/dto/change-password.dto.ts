import { z } from 'zod';

// POST /auth/change-password body. Strict: nothing else is accepted. Neither value is trimmed (spaces are part of a password); the
// NEW password's policy (10..72 UTF-8 bytes, not the account email, not the current password) is assertPasswordPolicy, applied by the
// service against the account's own email.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
}).strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
