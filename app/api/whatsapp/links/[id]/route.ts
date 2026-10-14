import { requireUser } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { revokeLinkForUser } from '@/server/whatsapp/link.service';

/**
 * DELETE /api/whatsapp/links/:id — unlink one of the signed-in user's own
 * WhatsApp numbers. Anyone else's link answers 404, the same as no link.
 */
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const user = await requireUser();
    await revokeLinkForUser(user.id, params.id);
    return jsonOk({ unlinked: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
