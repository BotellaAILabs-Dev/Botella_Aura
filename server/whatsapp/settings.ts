import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';

/**
 * A workspace's WhatsApp setting (Company.preferences.whatsappAssistant):
 * whether its members may use Aura on WhatsApp in it. On by default. When off,
 * the workspace is not offered on WhatsApp and anyone using it there loses
 * access on their next message (server/whatsapp/link.service.ts).
 */

type Bag = Record<string, unknown>;
const bagOf = (v: unknown): Bag => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : {});

export function whatsAppEnabledIn(preferences: unknown): boolean {
  const section = bagOf(bagOf(preferences).whatsappAssistant);
  return section.enabled !== false;
}

/** Which of these workspaces allow WhatsApp. */
export async function enabledWorkspaces(companyIds: string[]): Promise<Set<string>> {
  if (!companyIds.length) return new Set();
  const rows = await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, preferences: true } });
  return new Set(rows.filter((r) => whatsAppEnabledIn(r.preferences)).map((r) => r.id));
}

/** Turn members' WhatsApp access on or off (the caller checks company:update). */
export async function setWhatsAppEnabled(args: { companyId: string; userId: string; enabled: boolean }): Promise<void> {
  const company = await db.company.findUniqueOrThrow({ where: { id: args.companyId }, select: { preferences: true } });
  const bag = bagOf(company.preferences);
  // Merge: preferences also hold brand, formats, autopilot…
  await db.company.update({
    where: { id: args.companyId },
    data: { preferences: { ...bag, whatsappAssistant: { ...bagOf(bag.whatsappAssistant), enabled: args.enabled } } as Prisma.InputJsonObject },
  });
  await recordAudit({
    action: 'WHATSAPP_SETTINGS_UPDATED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { enabled: args.enabled },
  });
}
