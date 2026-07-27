import { forgotPasswordSchema } from '@/lib/validations/auth';
import { createPasswordResetToken } from '@/server/services/auth-token.service';
import { sendPasswordResetEmail } from '@/lib/email';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * POST /api/auth/forgot-password — begin the reset flow.
 * Always responds 200 with the same message whether or not the email exists,
 * so the endpoint cannot be used to enumerate accounts. When a user matches, a
 * single-use token is created and the reset link is "sent" (console transport
 * in Sprint 1 — see lib/email.ts).
 */
export async function POST(req: Request) {
  try {
    const rl = rateLimit(`forgot:${clientIp(req)}`, { limit: 5, windowMs: 60_000 });
    if (!rl.allowed) {
      return jsonError('Too many attempts. Please wait a moment.', 429);
    }
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
