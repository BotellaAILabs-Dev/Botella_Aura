import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { rateLimit } from '@/lib/rate-limit';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { ADMIN_MESSAGE_MAX, AdminMessageError, sendAdminMessage } from '@/server/whatsapp/admin-message';

/**
 * POST /api/whatsapp/send { userId, text } — an owner or admin messages a
 * member of the active workspace on WhatsApp. Narrow by design
 * (server/whatsapp/admin-message.ts): only members using WhatsApp in this
 * workspace, only inside Meta's 24-hour window, never after STOP, text only,
 * signed with the sender's name, audited. Not for arbitrary numbers or
 * marketing.
 */
export const dynamic = 'force-dynamic';

const Body = z.object({
  userId: z.string().min(1).max(64),
  text: z.string().min(1).max(ADMIN_MESSAGE_MAX),
});

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can message members.', 403);
    const limit = rateLimit(`whatsapp-send:${user.id}`, { limit: 10, windowMs: 60_000 });
    if (!limit.allowed) return jsonError(`Too many messages. Try again in ${limit.retryAfterSeconds}s.`, 429);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(`Send { "userId": "…", "text": "1–${ADMIN_MESSAGE_MAX} characters" }.`, 400);
    const result = await sendAdminMessage({
      companyId: company.id,
      companyName: company.name,
      senderId: user.id,
      senderName: user.name || user.email || 'A workspace admin',
      recipientUserId: parsed.data.userId,
      text: parsed.data.text,
    });
    return jsonOk(result);
  } catch (error) {
    if (error instanceof AdminMessageError) return jsonError(error.message, error.status);
    return handleRouteError(error);
  }
}
