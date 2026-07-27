import { resetPasswordSchema } from '@/lib/validations/auth';
import { resetPasswordWithToken } from '@/server/services/auth-token.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * POST /api/auth/reset-password — complete the reset with a valid token.
 * Rate-limited (Sprint 6). The token service enforces single-use + expiry.
 */
export async function POST(req: Request) {
  try {
    const rl = rateLimit(`reset:${clientIp(req)}`, { limit: 10, windowMs: 60_000 });
    if (!rl.allowed) {
      return jsonError('Too many attempts. Please wait a moment.', 429);
    }
    const { token, password } = resetPasswordSchema.parse(await req.json());
    await resetPasswordWithToken(token, password);
    return jsonOk({ message: 'Your password has been reset. You can log in now.' });
  } catch (error) {
    return handleRouteError(error);
  }
}
