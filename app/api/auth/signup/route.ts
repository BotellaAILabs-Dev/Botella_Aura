import { signUpSchema } from '@/lib/validations/auth';
import { createUserWithPassword } from '@/server/services/user.service';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/**
 * POST /api/auth/signup — create a local email/password account.
 * Validates with Zod (NON-NEGOTIABLE #2) before any DB access, then delegates
 * to the user service (which hashes the password + writes the audit entry).
 */
export async function POST(req: Request) {
  try {
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
