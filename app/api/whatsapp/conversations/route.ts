import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { listWorkspaceConversations } from '@/server/whatsapp/dashboard.service';

/**
 * GET /api/whatsapp/conversations?limit=20&messages=20 — WhatsApp
 * conversations handled for the ACTIVE workspace, newest first.
 *
 *   owners / admins (company:update)  every member's conversation here
 *   everyone else                     their own number(s) only
 *
 * Only messages handled for this workspace are included — never another
 * workspace's, never sign-in chatter from numbers not yet linked.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    const url = new URL(req.url);
    const all = can(membership.role, 'company:update');
    const conversations = await listWorkspaceConversations({
      companyId: company.id,
      ...(all ? {} : { userId: user.id }),
      limit: Number(url.searchParams.get('limit')) || 20,
      messagesEach: Number(url.searchParams.get('messages')) || 20,
    });
    return jsonOk({ scope: all ? 'workspace' : 'mine', conversations });
  } catch (error) {
    return handleRouteError(error);
  }
}
