import { db } from '@/lib/db';
import { generateToken, sha256 } from '@/lib/crypto';
import { hashPassword } from '@/lib/password';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Password-reset token lifecycle.
 *
 * Security properties:
 *  - Only a SHA-256 hash of the token is stored; the raw token exists only in
 *    the emailed link. A DB leak therefore does not expose usable tokens.
 *  - Tokens are single-use (usedAt) and time-boxed (1 hour).
 *  - Requesting a reset for an unknown email is a silent no-op so the endpoint
 *    cannot be used to enumerate registered accounts.
 */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RequestResetResult {
  /** The raw token to embed in the reset link, or null if no user matched. */
  rawToken: string | null;
}

export async function createPasswordResetToken(
  email: string,
): Promise<RequestResetResult> {
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  // Silent no-op to prevent account enumeration.
  if (!user) return { rawToken: null };

  const rawToken = generateToken(32);
  const tokenHash = sha256(rawToken);

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  await recordAudit({
    action: 'PASSWORD_RESET_REQUESTED',
    userId: user.id,
  });

  return { rawToken };
}

export class InvalidResetTokenError extends Error {
  readonly status = 400;
  constructor() {
    super('This reset link is invalid or has expired.');
    this.name = 'InvalidResetTokenError';
  }
}

/**
 * Consume a reset token and set a new password atomically. Marks the token used
 * and revokes the user's other outstanding reset tokens as a safety measure.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
): Promise<void> {
  const tokenHash = sha256(rawToken);
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new InvalidResetTokenError();
  }

  const passwordHash = await hashPassword(newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    // Invalidate any other outstanding tokens for this user.
    await tx.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await recordAudit(
      { action: 'PASSWORD_RESET_COMPLETED', userId: record.userId },
      tx,
    );
  });
}
