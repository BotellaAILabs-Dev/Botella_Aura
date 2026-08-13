/**
 * Dashboard snapshot — the "what needs you now" data behind the Overview page.
 *
 * The dashboard leads with ACTION ITEMS (drafts awaiting your approval, outreach
 * ready to send, fresh leads to review) instead of generic feature cards, so the
 * end-to-end workflow is visible the moment you land. Every count is real, scoped
 * to the active company, and links straight to where the work happens. When
 * everything is zero we say so honestly (genuine empty state) rather than faking
 * activity.
 */
import { db } from '@/lib/db';

export interface DashboardActionItem {
  key: string;
  count: number;
  label: string;
  /** Shown when count > 0 — the specific thing waiting on the human. */
  detail: string;
  href: string;
}

export interface DashboardTrendPeek {
  title: string;
  count: number;
  date: string;
}

export interface DashboardSnapshot {
  actions: DashboardActionItem[];
  /** Sum of all action-item counts — 0 means a genuinely clear queue. */
  totalPending: number;
  trend: DashboardTrendPeek | null;
  totals: {
    leads: number;
    drafts: number;
    campaigns: number;
    activeCampaigns: number;
  };
}

interface TrendPayload {
  items?: Array<{ title?: string }>;
}

export async function getDashboardSnapshot(
  companyId: string,
): Promise<DashboardSnapshot> {
  const [
    pendingContent,
    approvedContent,
    pendingOutreach,
    approvedOutreach,
    newLeads,
    qualifiedLeads,
    totalLeads,
    totalDrafts,
    totalCampaigns,
    activeCampaigns,
    latestDigest,
  ] = await Promise.all([
    db.contentDraft.count({
      where: { companyId, status: 'PENDING_APPROVAL' },
    }),
    db.contentDraft.count({
      where: { companyId, status: 'APPROVED', publishedAt: null },
    }),
    db.outreachMessage.count({
      where: { companyId, status: 'PENDING_APPROVAL' },
    }),
    db.outreachMessage.count({
      where: { companyId, status: 'APPROVED' },
    }),
    db.lead.count({ where: { companyId, status: 'NEW' } }),
    db.lead.count({ where: { companyId, status: 'QUALIFIED' } }),
    db.lead.count({ where: { companyId } }),
    db.contentDraft.count({ where: { companyId } }),
    db.campaign.count({ where: { companyId } }),
    db.campaign.count({ where: { companyId, status: 'ACTIVE' } }),
    db.trendDigest.findFirst({
      where: { companyId },
      orderBy: { date: 'desc' },
      select: { date: true, payload: true },
    }),
  ]);

  const freshLeads = newLeads + qualifiedLeads;

  const actions: DashboardActionItem[] = [
    {
      key: 'content-approval',
      count: pendingContent,
      label: 'Drafts awaiting your approval',
      detail:
        pendingContent === 1
          ? '1 content draft is ready for you to review and approve.'
          : `${pendingContent} content drafts are ready for you to review and approve.`,
      href: '/dashboard/content',
    },
    {
      key: 'outreach-approval',
      count: pendingOutreach,
      label: 'Outreach messages to approve',
      detail:
        pendingOutreach === 1
          ? '1 outreach message is drafted and waiting for your approval.'
          : `${pendingOutreach} outreach messages are drafted and waiting for your approval.`,
      href: '/dashboard/outreach',
    },
    {
      key: 'outreach-send',
      count: approvedOutreach,
      label: 'Approved outreach ready to send',
      detail:
        approvedOutreach === 1
          ? '1 approved message is queued for you to send from the extension.'
          : `${approvedOutreach} approved messages are queued for you to send from the extension.`,
      href: '/dashboard/outreach',
    },
    {
      key: 'content-publish',
      count: approvedContent,
      label: 'Approved content ready to publish',
      detail:
        approvedContent === 1
          ? '1 approved post is ready to schedule or publish.'
          : `${approvedContent} approved posts are ready to schedule or publish.`,
      href: '/dashboard/content',
    },
    {
      key: 'leads-review',
      count: freshLeads,
      label: 'New leads to review',
      detail:
        freshLeads === 1
          ? '1 new lead is waiting for you to qualify and draft outreach.'
          : `${freshLeads} new leads are waiting for you to qualify and draft outreach.`,
      href: '/dashboard/leads',
    },
  ];

  let trend: DashboardTrendPeek | null = null;
  if (latestDigest) {
    const payload = (latestDigest.payload as TrendPayload) ?? {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const topTitle = items[0]?.title;
    if (topTitle) {
      trend = {
        title: topTitle,
        count: items.length,
        date: latestDigest.date.toISOString(),
      };
    }
  }

  return {
    actions,
    totalPending: actions.reduce((sum, a) => sum + a.count, 0),
    trend,
    totals: {
      leads: totalLeads,
      drafts: totalDrafts,
      campaigns: totalCampaigns,
      activeCampaigns,
    },
  };
}
