import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { cancelChallenge } from '@/server/whatsapp/link.service';

/** POST /api/whatsapp/link/cancel { token } — "this isn't me": the link stops working. */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const user = await requireUser();
    const { token } = bodySchema.parse(await req.json());
    await cancelChallenge({ token, userId: user.id });
    return jsonOk({ cancelled: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
