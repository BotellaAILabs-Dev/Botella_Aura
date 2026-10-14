import { db } from '@/lib/db';
import { whatsAppConfig, withinServiceWindow } from '@/lib/whatsapp';
import { sessionState } from '@/lib/whatsapp-link';
import { getMembership } from '@/server/services/company.service';
import { recordAudit } from '@/server/services/audit.service';
import { sendContent } from '@/server/whatsapp/whatsapp.service';
import { enabledWorkspaces } from '@/server/whatsapp/settings';

/**
 * An owner or admin messaging a member of THEIR workspace on WhatsApp, from
 * the website (POST /api/whatsapp/send). Deliberately narrow — this is not a
 * way to message arbitrary numbers or to market:
 *
 *   - only to a member of this workspace, on a number they linked themselves
 *     and are using in this workspace right now;
 *   - only inside Meta's 24-hour window (they wrote to Aura recently) —
 *     nothing proactive, which would need an approved template;
 *   - never to someone who sent STOP;
 *   - text only, signed with the sender's name and the workspace, so it is
 *     never mistaken for Aura itself;
 *   - recorded against the workspace and audited.
 */

export const ADMIN_MESSAGE_MAX = 1000;

export class AdminMessageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AdminMessageError';
  }
}

export interface AdminMessageResult {
  sent: number;
  /** Numbers not messaged, and why (no numbers, digits, or tokens). */
  skipped: { last4: string; reason: 'outside_24h_window' | 'opted_out' | 'session_expired' | 'send_failed' }[];
}

export async function sendAdminMessage(args: {
  companyId: string;
  companyName: string;
  senderId: string;
  senderName: string;
  recipientUserId: string;
  text: string;
}): Promise<AdminMessageResult> {
  const config = whatsAppConfig();
  if (!config) throw new AdminMessageError('WhatsApp is not set up on this server.', 503);
  const text = args.text.trim();
  if (!text || text.length > ADMIN_MESSAGE_MAX) {
    throw new AdminMessageError(`Write 1–${ADMIN_MESSAGE_MAX} characters.`, 400);
  }
  if (!(await enabledWorkspaces([args.companyId])).has(args.companyId)) {
    throw new AdminMessageError('WhatsApp is turned off for this workspace.', 409);
  }
  // Same answer for "not a member" and "no such person": nothing to learn.
  if (!(await getMembership(args.recipientUserId, args.companyId))) {
    throw new AdminMessageError('That person isn’t using WhatsApp in this workspace.', 404);
  }
  const links = await db.whatsAppAccountLink.findMany({
    where: { userId: args.recipientUserId, activeCompanyId: args.companyId, revokedAt: null },
    include: { conversation: true },
  });
  if (!links.length) throw new AdminMessageError('That person isn’t using WhatsApp in this workspace.', 404);

  const body = `💬 ${args.senderName} (${args.companyName}), via Aura:\n\n${text}`;
  const result: AdminMessageResult = { sent: 0, skipped: [] };
  for (const link of links) {
    const last4 = link.conversation.waIdLast4;
    if (sessionState(link) !== 'active') result.skipped.push({ last4, reason: 'session_expired' });
    else if (link.conversation.optedOut) result.skipped.push({ last4, reason: 'opted_out' });
    else if (!withinServiceWindow(link.conversation.lastInboundAt)) result.skipped.push({ last4, reason: 'outside_24h_window' });
    else {
      const r = await sendContent({ config, conversation: link.conversation, content: { kind: 'text', text: body }, companyId: args.companyId });
      if (r.status === 'failed') result.skipped.push({ last4, reason: 'send_failed' });
      else result.sent++;
    }
  }
  await recordAudit({
    action: 'WHATSAPP_ADMIN_MESSAGE_SENT',
    userId: args.senderId,
    companyId: args.companyId,
    // The text itself is in the message history, not the audit log.
    metadata: { recipientUserId: args.recipientUserId, sent: result.sent, skipped: result.skipped.map((s) => s.reason), length: text.length },
  });
  return result;
}
