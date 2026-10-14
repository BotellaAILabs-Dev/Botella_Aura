import { requireUser } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { listLinksForUser } from '@/server/whatsapp/link.service';

/** GET /api/whatsapp/links — the signed-in user's own linked WhatsApp numbers (last four digits only). */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return jsonOk({ links: await listLinksForUser(user.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}
