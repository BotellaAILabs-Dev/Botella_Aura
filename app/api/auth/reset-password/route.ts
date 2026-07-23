import { resetPasswordSchema } from '@/lib/validations/auth';
import { resetPasswordWithToken } from '@/server/services/auth-token.service';
import { handleRouteError, jsonOk } from '@/lib/api';

/**
 * POST /api/auth/reset-password — complete the reset with a valid token.
 * The token service enforces single-use + expiry and audits the change.
 */
export async function POST(req: Request) {
  try {
    const { token, password } = resetPasswordSchema.parse(await req.json());
    await resetPasswordWithToken(token, password);
    return jsonOk({ message: 'Your password has been reset. You can log in now.' });
  } catch (error) {
    return handleRouteError(error);
  }
}
