import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { whatsAppConfig, withinServiceWindow } from '@/lib/whatsapp';
import { sessionState } from '@/lib/whatsapp-link';
import { sendContent } from '@/server/whatsapp/whatsapp.service';

/**
 * Tell a user on WhatsApp that something they started has finished (a
 * connection completed, a long job done). Best effort and never thrown: the
 * thing itself has already succeeded.
 *
 * Sent only to their linked, current sessions whose active workspace is the
 * one it happened in — never to another person, never about another
 * business — and only inside Meta's 24-hour window (nothing proactive
 * outside it; that would need an approved template). Never marketing.
 */
export async function notifyUser(args: { userId: string; companyId: string; text: string }): Promise<number> {
  try {
    const config = whatsAppConfig();
    if (!config) return 0;
    const links = await db.whatsAppAccountLink.findMany({
      where: { userId: args.userId, activeCompanyId: args.companyId, revokedAt: null },
      include: { conversation: true },
    });
    let sent = 0;
    for (const link of links) {
      if (sessionState(link) !== 'active') continue;
      if (link.conversation.optedOut || !withinServiceWindow(link.conversation.lastInboundAt)) continue;
      const r = await sendContent({ config, conversation: link.conversation, content: { kind: 'text', text: args.text }, companyId: args.companyId });
      if (r.status !== 'failed') sent++;
    }
    return sent;
  } catch (err) {
    logger.warn('whatsapp: notification not sent', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
