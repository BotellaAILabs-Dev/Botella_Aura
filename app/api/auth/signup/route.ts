import { signUpSchema } from '@/lib/validations/auth';
import { createUserWithPassword } from '@/server/services/user.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * POST /api/auth/signup — create a local email/password account.
 * Rate-limited (Sprint 6) + Zod-validated (NON-NEGOTIABLE #2) before any DB
 * access, then delegates to the user service (hashes password + audits).
 */
export async function POST(req: Request) {
  try {
    const rl = rateLimit(`signup:${clientIp(req)}`, { limit: 5, windowMs: 60_000 });
    if (!rl.allowed) {
      return jsonError('Too many attempts. Please wait a moment and try again.', 429);
    }
    const body = await req.json();
    const data = signUpSchema.parse(body);

    const user = await createUserWithPassword({
      ...data,
      requestMeta: getRequestMeta(req),
    });

    // Never return the password hash.
    return jsonOk(
      { id: user.id, email: user.email, name: user.name },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
