import { forgotPasswordSchema } from '@/lib/validations/auth';
import { createPasswordResetToken } from '@/server/services/auth-token.service';
import { sendPasswordResetEmail } from '@/lib/email';
import { absoluteUrl } from '@/lib/app-url';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

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
      const resetUrl = absoluteUrl(
        `/reset-password?token=${encodeURIComponent(rawToken)}`,
      );
      const delivery = await sendPasswordResetEmail(email, resetUrl);
      // We still answer with the same neutral message (no account enumeration),
      // but a real delivery failure must be visible in the server log.
      if (!delivery.delivered) {
        logger.error('forgot-password: reset email was not delivered', {
          transport: delivery.transport,
          notConfigured: Boolean(delivery.notConfigured),
          error: delivery.error,
        });
      }
    }

    return jsonOk({
      message:
        'If an account exists for that email, a reset link is on its way.',
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
