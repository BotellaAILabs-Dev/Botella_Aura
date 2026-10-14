import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { missingConfig } from '@/lib/whatsapp';
import { ROLE_LABEL } from '@/lib/whatsapp-link';
import { db } from '@/lib/db';
import { WHATSAPP_COMMANDS, whatsAppFeatures } from '@/server/whatsapp/features';
import { whatsAppEnabledIn } from '@/server/whatsapp/settings';

/**
 * GET /api/whatsapp/features — what the signed-in person can do with Aura on
 * WhatsApp in the active workspace, in their role. Read from the same tool
 * registry the assistant runs on, so it matches the WhatsApp menu exactly.
 * Names of missing settings only, never their values.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company, membership } = await requireActiveCompany();
    const prefs = await db.company.findUnique({ where: { id: company.id }, select: { preferences: true } });
    const missing = missingConfig();
    return jsonOk({
      workspace: { id: company.id, name: company.name },
      role: membership.role,
      roleLabel: ROLE_LABEL[membership.role],
      enabled: whatsAppEnabledIn(prefs?.preferences),
      configured: missing.length === 0,
      displayNumber: process.env.WHATSAPP_DISPLAY_NUMBER?.trim() || null,
      categories: whatsAppFeatures(membership.role),
      commands: WHATSAPP_COMMANDS,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
