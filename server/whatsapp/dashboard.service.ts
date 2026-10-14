import type { CompanyRole } from '@prisma/client';

import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { missingConfig } from '@/lib/whatsapp';
import { sessionState } from '@/lib/whatsapp-link';
import { listLinksForUser, type LinkView } from '@/server/whatsapp/link.service';
import { retentionDays } from '@/server/whatsapp/queue';
import { whatsAppEnabledIn } from '@/server/whatsapp/settings';

/**
 * The WhatsApp Assistant page for ONE workspace.
 *
 * The central number is shared by every workspace, so nothing here is
 * platform-wide: the activity shown is only messages handled FOR this
 * workspace (WhatsAppMessage.companyId), and only to its owners and admins.
 * Everyone sees their own linked numbers. Sign-in chatter from numbers not
 * yet linked belongs to no workspace and appears nowhere.
 */

export interface DashboardMessage {
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  status: string;
  at: string;
  error: string | null;
}

export interface DashboardConversation {
  id: string;
  who: string;
  last4: string;
  lastAt: string;
  messages: DashboardMessage[];
}

/**
 * Recent conversations handled for ONE workspace, newest first, each with its
 * latest messages (oldest first). Only messages tagged with this workspace are
 * read; `userId` narrows it to one person's own number(s).
 */
export async function listWorkspaceConversations(args: {
  companyId: string;
  userId?: string;
  limit?: number;
  messagesEach?: number;
}): Promise<DashboardConversation[]> {
  const { companyId } = args;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const each = Math.min(Math.max(args.messagesEach ?? 20, 1), 50);
  const recent = await db.whatsAppMessage.findMany({
    where: { companyId, ...(args.userId ? { conversation: { link: { is: { userId: args.userId } } } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit * each,
    select: { conversationId: true, direction: true, body: true, status: true, createdAt: true, errorMessage: true },
  });

  // Group by conversation, newest conversations first.
  const byConv = new Map<string, typeof recent>();
  for (const m of recent) (byConv.get(m.conversationId) ?? byConv.set(m.conversationId, []).get(m.conversationId)!).push(m);
  const convIds = [...byConv.keys()].slice(0, limit);
  const convs = await db.whatsAppConversation.findMany({
    where: { id: { in: convIds } },
    select: {
      id: true,
      waIdLast4: true,
      link: { select: { user: { select: { name: true, email: true, memberships: { where: { companyId }, select: { role: true } } } } } },
    },
  });
  const convById = new Map(convs.map((c) => [c.id, c]));

  return convIds.map((id) => {
    const c = convById.get(id);
    const msgs = byConv.get(id)!.slice(0, each).reverse();
    return {
      id,
      // Named only if the number's current owner is a member here (a number
      // can be re-linked to someone else since).
      who: c?.link?.user?.memberships?.length ? c.link.user.name || c.link.user.email : 'Unknown',
      last4: c?.waIdLast4 ?? '????',
      lastAt: msgs.at(-1)!.createdAt.toISOString(),
      messages: msgs.map((m) => ({
        direction: m.direction,
        body: (m.body ?? '').slice(0, 600),
        status: m.status,
        at: m.createdAt.toISOString(),
        error: m.errorMessage,
      })),
    };
  });
}

export interface DashboardData {
  integration: { configured: boolean; missing: string[]; displayNumber: string | null; retentionDays: number };
  enabled: boolean;
  canManage: boolean;
  myLinks: (LinkView & { workspace: string | null })[];
  team: null | {
    linked: { userId: string; name: string; email: string; role: string; last4: string; lastUsedAt: string; state: string }[];
    week: { inbound: number; outbound: number; byStatus: Record<string, number> };
    conversations: DashboardConversation[];
    failures: { at: string; code: string | null; message: string | null; body: string }[];
    deadJobs: { at: string; error: string | null; body: string }[];
  };
}

export async function getWhatsAppDashboard(args: { companyId: string; userId: string; role: CompanyRole }): Promise<DashboardData> {
  const { companyId } = args;
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { preferences: true } });
  const links = await listLinksForUser(args.userId);
  const names = new Map(
    (await db.company.findMany({ where: { id: { in: links.map((l) => l.activeCompanyId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );
  const missing = missingConfig();
  const data: DashboardData = {
    integration: {
      configured: missing.length === 0,
      missing,
      displayNumber: process.env.WHATSAPP_DISPLAY_NUMBER?.trim() || null,
      retentionDays: retentionDays(),
    },
    enabled: whatsAppEnabledIn(company.preferences),
    canManage: can(args.role, 'company:update'),
    myLinks: links.map((l) => ({ ...l, workspace: l.activeCompanyId ? (names.get(l.activeCompanyId) ?? null) : null })),
    team: null,
  };
  if (!data.canManage) return data;

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [linked, week, conversations, failures, dead] = await Promise.all([
    // Members whose WhatsApp is working in THIS workspace.
    db.whatsAppAccountLink.findMany({
      where: { activeCompanyId: companyId, revokedAt: null, user: { memberships: { some: { companyId } } } },
      include: {
        user: { select: { name: true, email: true, memberships: { where: { companyId }, select: { role: true } } } },
        conversation: { select: { waIdLast4: true } },
      },
      orderBy: { lastUsedAt: 'desc' },
      take: 100,
    }),
    db.whatsAppMessage.groupBy({
      by: ['direction', 'status'],
      where: { companyId, createdAt: { gte: weekAgo } },
      _count: { _all: true },
    }),
    listWorkspaceConversations({ companyId }),
    db.whatsAppMessage.findMany({
      where: { companyId, direction: 'OUTBOUND', status: 'FAILED', createdAt: { gte: weekAgo } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { createdAt: true, errorCode: true, errorMessage: true, body: true },
    }),
    db.whatsAppJob.findMany({
      where: { status: 'DEAD', message: { companyId }, createdAt: { gte: weekAgo } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { createdAt: true, lastError: true, message: { select: { body: true } } },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let inbound = 0;
  let outbound = 0;
  for (const g of week) {
    if (g.direction === 'INBOUND') inbound += g._count._all;
    else {
      outbound += g._count._all;
      byStatus[g.status] = (byStatus[g.status] ?? 0) + g._count._all;
    }
  }

  data.team = {
    linked: linked.map((l) => ({
      userId: l.userId,
      name: l.user.name ?? '',
      email: l.user.email,
      role: l.user.memberships[0]?.role ?? '',
      last4: l.conversation.waIdLast4,
      lastUsedAt: l.lastUsedAt.toISOString(),
      state: sessionState(l),
    })),
    week: { inbound, outbound, byStatus },
    conversations,
    failures: failures.map((f) => ({ at: f.createdAt.toISOString(), code: f.errorCode, message: f.errorMessage, body: (f.body ?? '').slice(0, 200) })),
    deadJobs: dead.map((j) => ({ at: j.createdAt.toISOString(), error: j.lastError, body: (j.message.body ?? '').slice(0, 200) })),
  };
  return data;
}
