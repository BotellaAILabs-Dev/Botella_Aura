import type { WorkspaceBriefing } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { startOfIsoWeekUTC } from '@/server/competitors/report.service';
import { resolvePlatform } from '@/lib/platforms';
import { draftSnippet } from '@/lib/content-ui';
import { assetFileUrl } from '@/server/media/asset-url';
import type { ContentTypeKey } from '@/lib/validations/content';
import {
  readBriefingActivity,
  readBriefingPayload,
  type BriefingActivity,
  type BriefingCalendarItem,
  type BriefingContentItem,
  type BriefingPayload,
} from '@/lib/validations/briefing';
import type { PlanItem } from '@/lib/validations/planner';

/**
 * The weekly briefing — assembly, not generation.
 *
 * Everything here already existed somewhere: trend digests, competitor reports,
 * advisor opportunities, intelligence snapshots, marketing memory, content
 * drafts. What was missing was anything that put them in one place, in the
 * order a person cares about, on a schedule.
 *
 * So this makes NO model calls of its own. It reads what the existing pipelines
 * produced and composes it. That matters for three reasons: assembling is
 * instant, it costs nothing, and a briefing can be rebuilt at any time without
 * re-running (or re-paying for) the work it summarises.
 *
 * NON-NEGOTIABLE, inherited from the rest of this codebase: nothing here
 * invents. A section with no real data is an empty section plus an honest line
 * in `coverage.skipped` saying why — never a plausible-looking placeholder.
 */

export interface BriefingView {
  id: string;
  weekStart: string;
  weekEnd: string;
  status: WorkspaceBriefing['status'];
  payload: BriefingPayload;
  activity: BriefingActivity;
  error: string | null;
  generatedAt: string;
  isCurrentWeek: boolean;
  /** False until the human has opened it — drives the "new" marker. */
  read: boolean;
}

export function toBriefingView(row: WorkspaceBriefing): BriefingView {
  const weekStart = startOfIsoWeekUTC(new Date());
  return {
    id: row.id,
    weekStart: row.weekStart.toISOString(),
    weekEnd: row.weekEnd.toISOString(),
    status: row.status,
    payload: readBriefingPayload(row.payload),
    activity: readBriefingActivity(row.activity),
    error: row.error,
    generatedAt: row.generatedAt.toISOString(),
    isCurrentWeek: row.weekStart.getTime() === weekStart.getTime(),
    read: row.readAt !== null,
  };
}

/** The briefing for the current week, if one exists. */
export async function getCurrentBriefing(
  companyId: string,
): Promise<WorkspaceBriefing | null> {
  return db.workspaceBriefing.findUnique({
    where: {
      companyId_weekStart: { companyId, weekStart: startOfIsoWeekUTC(new Date()) },
    },
  });
}

/**
 * The most recent briefing, whatever week it is for.
 *
 * The home page uses this rather than strictly this week's: on a Monday
 * morning before the cron has run, last week's briefing is far more useful
 * than an empty screen, and `isCurrentWeek` lets the UI label it honestly.
 */
export async function getLatestBriefing(
  companyId: string,
): Promise<WorkspaceBriefing | null> {
  return db.workspaceBriefing.findFirst({
    where: { companyId },
    orderBy: { weekStart: 'desc' },
  });
}

export async function markBriefingRead(
  companyId: string,
  briefingId: string,
): Promise<void> {
  await db.workspaceBriefing.updateMany({
    where: { id: briefingId, companyId, readAt: null },
    data: { readAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Skip {
  source: string;
  reason: string;
}

/**
 * Build this week's briefing payload from everything already in the database.
 *
 * Pure aggregation — safe to call as often as you like.
 */
export async function assembleBriefing(args: {
  companyId: string;
  weekStart: Date;
  weekEnd: Date;
}): Promise<BriefingPayload> {
  const { companyId, weekStart, weekEnd } = args;
  const used: string[] = [];
  const skipped: Skip[] = [];

  const [
    company,
    drafts,
    latestDigest,
    competitorReport,
    advisorReport,
    intelligence,
    memories,
    plan,
    pendingCounts,
  ] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    }),
    // Everything touched this week, plus anything still waiting — a draft
    // written three weeks ago that nobody approved is still what needs you.
    db.contentDraft.findMany({
      where: {
        companyId,
        OR: [
          { updatedAt: { gte: weekStart } },
          { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
        ],
      },
      orderBy: [{ scheduledFor: 'asc' }, { updatedAt: 'desc' }],
      take: 40,
      include: {
        media: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { assetId: true },
        },
      },
    }),
    db.trendDigest.findFirst({
      where: { companyId },
      orderBy: { date: 'desc' },
    }),
    db.competitorReport.findFirst({
      where: { companyId },
      orderBy: { weekStart: 'desc' },
    }),
    db.advisorReport.findFirst({
      where: { companyId },
      orderBy: { date: 'desc' },
    }),
    db.intelligenceSnapshot.findFirst({
      where: { companyId },
      orderBy: { date: 'desc' },
    }),
    db.marketingMemory.findMany({
      where: { companyId, isActive: true },
      orderBy: { generatedAt: 'desc' },
      take: 5,
    }),
    db.marketingPlan.findFirst({
      where: { companyId },
      orderBy: { month: 'desc' },
    }),
    countAttention(companyId),
  ]);

  // --- the week's calendar ------------------------------------------------
  const calendar = buildCalendar({ drafts, plan, weekStart, weekEnd });
  if (calendar.length > 0) used.push('calendar');
  else {
    skipped.push({
      source: 'calendar',
      reason:
        'No content planned or written for this week yet. Generate a monthly plan, or create content directly.',
    });
  }

  // --- content actually ready for a human ---------------------------------
  const readyContent = buildReadyContent(drafts);
  if (readyContent.length > 0) used.push('content');

  // --- competitor movement -------------------------------------------------
  const competitorMoves = buildCompetitorMoves(competitorReport?.payload);
  if (competitorMoves.length > 0) used.push('competitors');
  else if (!competitorReport) {
    skipped.push({
      source: 'competitors',
      reason:
        'No competitor report yet. Add competitors in Competitors and the weekly tracker will start reporting.',
    });
  }

  // --- recommendations -----------------------------------------------------
  const recommendations = buildRecommendations({
    advisor: advisorReport?.payload,
    digest: latestDigest?.payload,
    memories,
    pending: pendingCounts,
  });
  if (recommendations.length > 0) used.push('recommendations');

  // --- the numbers ---------------------------------------------------------
  const insights = buildInsights({
    intelligence: intelligence?.payload,
    drafts,
    memories,
  });
  if (insights.length > 0) used.push('insights');
  else {
    skipped.push({
      source: 'insights',
      reason:
        'Not enough measured activity yet. Publish content and sync its metrics, and these fill in.',
    });
  }

  const attention = buildAttention(pendingCounts);

  return {
    headline: buildHeadline({
      companyName: company?.name ?? 'your workspace',
      calendar,
      readyContent,
      attention,
    }),
    summary: buildSummary({ calendar, readyContent, competitorMoves, attention }),
    calendar,
    readyContent,
    competitorMoves,
    recommendations,
    insights,
    attention,
    coverage: { used, skipped },
  };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

type DraftWithMedia = Awaited<
  ReturnType<typeof db.contentDraft.findMany>
>[number] & { media: Array<{ assetId: string }> };

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The week's calendar: real drafts first, planned-but-unwritten items after.
 *
 * A written draft always wins over the plan entry that produced it — showing
 * both would double-count the same post.
 */
function buildCalendar(args: {
  drafts: DraftWithMedia[];
  plan: { payload: unknown } | null;
  weekStart: Date;
  weekEnd: Date;
}): BriefingCalendarItem[] {
  const { drafts, plan, weekStart, weekEnd } = args;
  const items: BriefingCalendarItem[] = [];
  const claimedTitles = new Set<string>();

  for (const draft of drafts) {
    const when = draft.scheduledFor ?? draft.updatedAt;
    if (when < weekStart || when > weekEnd) continue;

    const type = draft.type as ContentTypeKey;
    const title = draft.title ?? 'Untitled';
    claimedTitles.add(title.toLowerCase());
    items.push({
      date: isoDay(when),
      contentType: type,
      platform: resolvePlatform(type, draft.platform),
      title,
      theme: draftSnippet(type, draft.body).slice(0, 200),
      draftId: draft.id,
      status: draft.status,
      hasGraphic: draft.media.length > 0,
      graphicUrl: draft.media[0] ? assetFileUrl(draft.media[0].assetId) : null,
    });
  }

  // Planned items the agent has not written yet.
  const planItems = readPlanItems(plan?.payload);
  for (const item of planItems) {
    const date = new Date(`${item.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date < weekStart || date > weekEnd) continue;
    if (claimedTitles.has(item.title.toLowerCase())) continue;

    items.push({
      date: item.date,
      contentType: item.contentType,
      platform: resolvePlatform(item.contentType, null),
      title: item.title,
      theme: item.theme,
      draftId: null,
      status: 'PLANNED',
      hasGraphic: false,
      graphicUrl: null,
    });
  }

  return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 30);
}

function readPlanItems(payload: unknown): PlanItem[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? (items as PlanItem[]) : [];
}

/** Content the agent has written that is waiting on a person. */
function buildReadyContent(drafts: DraftWithMedia[]): BriefingContentItem[] {
  return drafts
    .filter((d) => d.status === 'DRAFT' || d.status === 'PENDING_APPROVAL' || d.status === 'APPROVED')
    .slice(0, 12)
    .map((draft) => {
      const type = draft.type as ContentTypeKey;
      return {
        draftId: draft.id,
        title: draft.title ?? 'Untitled',
        snippet: draftSnippet(type, draft.body).slice(0, 400),
        contentType: type,
        platform: resolvePlatform(type, draft.platform),
        status: draft.status,
        hasGraphic: draft.media.length > 0,
        graphicUrl: draft.media[0] ? assetFileUrl(draft.media[0].assetId) : null,
        scheduledFor: draft.scheduledFor ? draft.scheduledFor.toISOString() : null,
      };
    });
}

function buildCompetitorMoves(payload: unknown): BriefingPayload['competitorMoves'] {
  if (!payload || typeof payload !== 'object') return [];
  const competitors = (payload as { competitors?: unknown }).competitors;
  if (!Array.isArray(competitors)) return [];

  const moves: BriefingPayload['competitorMoves'] = [];
  for (const raw of competitors.slice(0, 15)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const name = typeof c.competitor === 'string' ? c.competitor : null;
    if (!name) continue;

    // Prefer the most concrete thing the report found; a competitor with
    // nothing new is not worth a row.
    const summary =
      pickString(c.newLaunches) ??
      pickString(c.pricingChanges) ??
      pickString(c.notableActivity);
    if (!summary) continue;

    moves.push({
      competitor: name,
      summary: summary.slice(0, 600),
      takeaway: (pickString(c.strategicTakeaway) ?? '').slice(0, 400),
      sourceUrl: null,
    });
  }
  return moves;
}

/** Reports store some fields as strings and some as arrays; normalise both. */
function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim());
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

interface AttentionCounts {
  pendingApproval: number;
  approvedUnscheduled: number;
  newLeads: number;
  outreachReady: number;
}

async function countAttention(companyId: string): Promise<AttentionCounts> {
  const [pendingApproval, approvedUnscheduled, newLeads, outreachReady] =
    await Promise.all([
      db.contentDraft.count({ where: { companyId, status: 'PENDING_APPROVAL' } }),
      db.contentDraft.count({
        where: { companyId, status: 'APPROVED', scheduledFor: null, publishedAt: null },
      }),
      db.lead.count({ where: { companyId, status: 'NEW' } }),
      db.outreachMessage.count({ where: { companyId, status: 'APPROVED' } }),
    ]);
  return { pendingApproval, approvedUnscheduled, newLeads, outreachReady };
}

function buildAttention(counts: AttentionCounts): BriefingPayload['attention'] {
  const rows = [
    {
      label: 'Posts waiting for your approval',
      count: counts.pendingApproval,
      href: '/dashboard/content',
    },
    {
      label: 'Approved posts with no publish time',
      count: counts.approvedUnscheduled,
      href: '/dashboard/content/calendar',
    },
    { label: 'New leads to review', count: counts.newLeads, href: '/dashboard/leads' },
    {
      label: 'Outreach ready to send',
      count: counts.outreachReady,
      href: '/dashboard/outreach',
    },
  ];
  return rows.filter((r) => r.count > 0);
}

function buildRecommendations(args: {
  advisor: unknown;
  digest: unknown;
  memories: Array<{ insight: string; confidence: string }>;
  pending: AttentionCounts;
}): BriefingPayload['recommendations'] {
  const out: BriefingPayload['recommendations'] = [];

  // The most actionable thing is always an unblocked queue.
  if (args.pending.pendingApproval > 0) {
    out.push({
      title: `Approve ${args.pending.pendingApproval} post${args.pending.pendingApproval === 1 ? '' : 's'}`,
      why: 'Written and waiting. Nothing publishes until a human approves it.',
      action: 'Review now',
      href: '/dashboard/content',
      priority: 'high',
    });
  }

  // Advisor opportunities, which are already evidence-backed.
  const opportunities = readArray(args.advisor, 'opportunities');
  for (const raw of opportunities.slice(0, 3)) {
    const o = raw as Record<string, unknown>;
    const title = pickString(o.title);
    if (!title) continue;
    out.push({
      title: title.slice(0, 200),
      why: (pickString(o.rationale) ?? '').slice(0, 600),
      action: 'Open the advisor',
      href: '/dashboard/advisor',
      priority: 'medium',
    });
  }

  // Learned patterns, but only where there was enough data to trust them.
  for (const memory of args.memories.filter((m) => m.confidence !== 'LOW').slice(0, 2)) {
    out.push({
      title: 'Apply what has been working',
      why: memory.insight.slice(0, 600),
      action: 'See marketing memory',
      href: '/dashboard/memory',
      priority: 'low',
    });
  }

  return out.slice(0, 10);
}

function readArray(payload: unknown, key: string): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function buildInsights(args: {
  intelligence: unknown;
  drafts: DraftWithMedia[];
  memories: unknown[];
}): BriefingPayload['insights'] {
  const out: BriefingPayload['insights'] = [];

  const score = args.intelligence && typeof args.intelligence === 'object'
    ? (args.intelligence as { overallScore?: unknown }).overallScore
    : null;
  if (typeof score === 'number') {
    const basis =
      args.intelligence && typeof args.intelligence === 'object'
        ? pickString((args.intelligence as Record<string, unknown>).overallBasis)
        : null;
    out.push({
      label: 'Marketing health',
      value: `${score}/100`,
      delta: null,
      note: (basis ?? '').slice(0, 300),
    });
  }

  const published = args.drafts.filter((d) => d.status === 'PUBLISHED').length;
  if (published > 0) {
    out.push({
      label: 'Published this week',
      value: String(published),
      delta: null,
      note: '',
    });
  }

  const withGraphics = args.drafts.filter((d) => d.media.length > 0).length;
  if (args.drafts.length > 0) {
    out.push({
      label: 'Posts with a graphic',
      value: `${withGraphics}/${args.drafts.length}`,
      delta: null,
      note: 'Posts with an image consistently outperform text-only ones.',
    });
  }

  return out.slice(0, 8);
}

function buildHeadline(args: {
  companyName: string;
  calendar: BriefingCalendarItem[];
  readyContent: BriefingContentItem[];
  attention: BriefingPayload['attention'];
}): string {
  const ready = args.readyContent.length;
  const planned = args.calendar.length;

  if (ready === 0 && planned === 0) {
    return 'Nothing scheduled yet this week.';
  }
  if (ready === 0) {
    return `${planned} post${planned === 1 ? '' : 's'} planned for this week.`;
  }
  const waiting = args.attention.reduce((sum, a) => sum + a.count, 0);
  return waiting > 0
    ? `${ready} post${ready === 1 ? '' : 's'} ready — ${waiting} thing${waiting === 1 ? '' : 's'} need you.`
    : `${ready} post${ready === 1 ? '' : 's'} ready for this week.`;
}

function buildSummary(args: {
  calendar: BriefingCalendarItem[];
  readyContent: BriefingContentItem[];
  competitorMoves: BriefingPayload['competitorMoves'];
  attention: BriefingPayload['attention'];
}): string {
  const parts: string[] = [];
  const withGraphics = args.readyContent.filter((c) => c.hasGraphic).length;

  if (args.readyContent.length > 0) {
    parts.push(
      `${args.readyContent.length} post${args.readyContent.length === 1 ? '' : 's'} written` +
        (withGraphics > 0 ? `, ${withGraphics} with a graphic already attached` : ''),
    );
  }
  const unwritten = args.calendar.filter((c) => c.status === 'PLANNED').length;
  if (unwritten > 0) parts.push(`${unwritten} still to write`);
  if (args.competitorMoves.length > 0) {
    parts.push(
      `${args.competitorMoves.length} competitor update${args.competitorMoves.length === 1 ? '' : 's'}`,
    );
  }

  if (parts.length === 0) {
    return 'No activity to report for this week yet.';
  }
  return `${parts.join('. ')}.`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Assemble and store this week's briefing.
 *
 * Idempotent per company per week: a second run replaces rather than
 * duplicating, which is what makes it safe for both the cron and a manual
 * refresh to call.
 */
export async function generateBriefing(args: {
  companyId: string;
  userId?: string | null;
  activity?: BriefingActivity;
  status?: 'WORKING' | 'READY';
}): Promise<WorkspaceBriefing> {
  const { companyId, userId, activity, status = 'READY' } = args;
  const weekStart = startOfIsoWeekUTC(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000 - 1);

  try {
    const payload = await assembleBriefing({ companyId, weekStart, weekEnd });

    const row = await db.workspaceBriefing.upsert({
      where: { companyId_weekStart: { companyId, weekStart } },
      create: {
        companyId,
        weekStart,
        weekEnd,
        status,
        payload: payload as object,
        ...(activity ? { activity: activity as object } : {}),
        generatedAt: new Date(),
      },
      update: {
        status,
        payload: payload as object,
        ...(activity ? { activity: activity as object } : {}),
        error: null,
        generatedAt: new Date(),
        // A refreshed briefing is new information, so it is unread again.
        readAt: null,
      },
    });

    await recordAudit({
      action: 'BRIEFING_GENERATED',
      userId: userId ?? null,
      companyId,
      metadata: {
        weekStart: weekStart.toISOString(),
        calendar: payload.calendar.length,
        ready: payload.readyContent.length,
        skipped: payload.coverage.skipped.map((s) => s.source),
      },
    });
    return row;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('briefing: assembly failed', { companyId, error: message });

    const row = await db.workspaceBriefing.upsert({
      where: { companyId_weekStart: { companyId, weekStart } },
      create: {
        companyId,
        weekStart,
        weekEnd,
        status: 'FAILED',
        error: message.slice(0, 1000),
      },
      update: { status: 'FAILED', error: message.slice(0, 1000) },
    });
    await recordAudit({
      action: 'BRIEFING_FAILED',
      userId: userId ?? null,
      companyId,
      metadata: { weekStart: weekStart.toISOString(), error: message.slice(0, 300) },
    });
    return row;
  }
}
