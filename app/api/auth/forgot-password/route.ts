import { forgotPasswordSchema } from '@/lib/validations/auth';
import { createPasswordResetToken } from '@/server/services/auth-token.service';
import { sendPasswordResetEmail } from '@/lib/email';
import { handleRouteError, jsonOk } from '@/lib/api';

/**
 * POST /api/auth/forgot-password — begin the reset flow.
 * Always responds 200 with the same message whether or not the email exists,
 * so the endpoint cannot be used to enumerate accounts. When a user matches, a
 * single-use token is created and the reset link is "sent" (console transport
 * in Sprint 1 — see lib/email.ts).
 */
export async function POST(req: Request) {
  try {
    const { email } = forgotPasswordSchema.parse(await req.json());

    const { rawToken } = await createPasswordResetToken(email);
    if (rawToken) {
      const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
      const resetUrl = `${base}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(email, resetUrl);
    }

    return jsonOk({
      message:
        'If an account exists for that email, a reset link is on its way.',
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
