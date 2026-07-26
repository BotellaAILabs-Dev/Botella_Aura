import { z } from 'zod';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import type {
  ChangesSummary,
  CompetitorReportEntry,
  CompetitorReportPayload,
} from '@/server/competitors/types';

/**
 * Weekly Competitor Report generator (Sprint 4, Module 1). Aggregates the past
 * week's CompetitorSnapshot signal per company and asks Claude for a structured
 * report (one section per competitor + an overall synthesis). Idempotent per
 * ISO week via upsert on (companyId, weekStart). Degrades to a deterministic
 * report when no ANTHROPIC_API_KEY is configured.
 */

/** Monday 00:00 UTC of the ISO week containing `d`. Exported for tests. */
export function startOfIsoWeekUTC(d: Date): Date {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = date.getUTCDay(); // 0 = Sunday
  const shift = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + shift);
  return date;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

const aiReportSchema = z.object({
  competitors: z.array(
    z.object({
      competitor: z.string(),
      newLaunches: z.array(z.string()),
      pricingChanges: z.array(z.string()),
      notableActivity: z.array(z.string()),
      strategicTakeaway: z.string(),
    }),
  ),
  synthesis: z.string(),
});

interface CompetitorSignal {
  id: string;
  name: string;
  homepageChanges: string[];
  pricingChanges: string[];
  news: { title: string; url: string }[];
  github: string[];
}

/** Collapse a week of snapshots per competitor into a compact signal bundle. */
function collectSignal(
  competitors: {
    id: string;
    name: string;
    snapshots: { changesSummary: unknown }[];
  }[],
): CompetitorSignal[] {
  return competitors.map((c) => {
    const homepageChanges: string[] = [];
    const pricingChanges: string[] = [];
    const news: { title: string; url: string }[] = [];
    const github: string[] = [];
    const seenNews = new Set<string>();

    for (const snap of c.snapshots) {
      const s = snap.changesSummary as ChangesSummary;
      if (s?.homepage) homepageChanges.push(s.homepage);
      if (s?.pricing) pricingChanges.push(s.pricing);
      for (const n of s?.news ?? []) {
        if (!seenNews.has(n.url)) {
          seenNews.add(n.url);
          news.push({ title: n.title, url: n.url });
        }
      }
      if (s?.github?.latestRelease) {
        github.push(
          `Release ${s.github.latestRelease.name} in ${s.github.latestRelease.repo}`,
        );
      }
    }
    return { id: c.id, name: c.name, homepageChanges, pricingChanges, news, github };
  });
}

/** Deterministic report used when Claude is unavailable. */
function deterministicReport(signal: CompetitorSignal[]): {
  entries: CompetitorReportEntry[];
  synthesis: string;
} {
  const entries: CompetitorReportEntry[] = signal.map((s) => ({
    competitorId: s.id,
    competitor: s.name,
    newLaunches: [...s.github, ...s.news.slice(0, 3).map((n) => n.title)],
    pricingChanges: s.pricingChanges,
    notableActivity: [...s.homepageChanges, ...s.news.slice(3, 6).map((n) => n.title)],
    strategicTakeaway:
      s.homepageChanges.length || s.pricingChanges.length || s.news.length
        ? 'Review the detected changes and consider whether your positioning or pricing needs a response.'
        : 'No material public activity detected this week.',
  }));
  const active = signal.filter(
    (s) => s.homepageChanges.length || s.pricingChanges.length || s.news.length,
  );
  const synthesis = active.length
    ? `${active.length} of ${signal.length} tracked competitors showed public activity this week: ${active
        .map((s) => s.name)
        .join(', ')}. Review the details and decide where to respond.`
    : 'No material competitor activity detected this week across your tracked list.';
  return { entries, synthesis };
}

async function buildPayload(
  signal: CompetitorSignal[],
  weekStart: Date,
  weekEnd: Date,
): Promise<CompetitorReportPayload> {
  const base = {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    generatedAt: new Date().toISOString(),
  };

  if (!isClaudeConfigured() || signal.length === 0) {
    const { entries, synthesis } = deterministicReport(signal);
    return { competitors: entries, synthesis, model: 'none', ...base };
  }

  try {
    const context = signal
      .map((s, i) =>
        [
          `#${i + 1} ${s.name}`,
          s.homepageChanges.length
            ? `  Homepage changes: ${s.homepageChanges.join(' | ')}`
            : '',
          s.pricingChanges.length
            ? `  Pricing changes: ${s.pricingChanges.join(' | ')}`
            : '',
          s.news.length
            ? `  News: ${s.news.map((n) => n.title).join(' | ')}`
            : '',
          s.github.length ? `  GitHub: ${s.github.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');

    const ai = await completeStructured({
      schema: aiReportSchema,
      system:
        'You are a competitive-intelligence analyst writing a weekly briefing ' +
        'for a marketing team. Be factual and concise; do NOT invent activity ' +
        'that is not in the provided signal. For each competitor, populate ' +
        'newLaunches, pricingChanges, notableActivity (arrays of short bullet ' +
        'strings; empty if none) and a one-sentence strategicTakeaway. Then ' +
        'write a short overall `synthesis` ("what this means for you"). ' +
        'Respond with ONLY JSON matching the schema.',
      prompt: `Competitor signal for the week:\n\n${context || '(no activity captured)'}\n\nReturn JSON: { competitors: [{ competitor, newLaunches[], pricingChanges[], notableActivity[], strategicTakeaway }], synthesis }`,
      maxTokens: 2000,
      effort: 'medium',
    });

    // Map AI entries back to competitor ids by name (robust to reordering).
    const byName = new Map(
      ai.competitors.map((c) => [c.competitor.toLowerCase().trim(), c]),
    );
    const entries: CompetitorReportEntry[] = signal.map((s) => {
      const match = byName.get(s.name.toLowerCase().trim());
      return {
        competitorId: s.id,
        competitor: s.name,
        newLaunches: match?.newLaunches ?? [],
        pricingChanges: match?.pricingChanges ?? [],
        notableActivity: match?.notableActivity ?? [],
        strategicTakeaway:
          match?.strategicTakeaway ?? 'No material activity detected this week.',
      };
    });
    return { competitors: entries, synthesis: ai.synthesis, model: DEFAULT_MODEL, ...base };
  } catch (err) {
    logger.warn('competitors: AI report failed, using deterministic fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    const { entries, synthesis } = deterministicReport(signal);
    return { competitors: entries, synthesis, model: 'none', ...base };
  }
}

/**
 * Generate (or regenerate) the weekly report for a company. `weekStart` lets
 * the caller target a specific ISO week; defaults to the current week.
 */
export async function generateWeeklyReport(args: {
  companyId: string;
  userId?: string | null;
  now?: Date;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}) {
  const { companyId, userId, requestMeta } = args;
  const now = args.now ?? new Date();
  const weekStart = startOfIsoWeekUTC(now);
  const weekEnd = addDays(weekStart, 7);

  await recordAudit({
    action: 'COMPETITOR_REPORT_REQUESTED',
    userId: userId ?? null,
    companyId,
    metadata: { weekStart: weekStart.toISOString() },
    ...requestMeta,
  });

  const competitors = await db.competitorProfile.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      snapshots: {
        where: { capturedAt: { gte: weekStart, lt: weekEnd } },
        select: { changesSummary: true },
        orderBy: { capturedAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const signal = collectSignal(competitors);
  const payload = await buildPayload(signal, weekStart, weekEnd);

  const report = await db.competitorReport.upsert({
    where: { companyId_weekStart: { companyId, weekStart } },
    create: {
      companyId,
      weekStart,
      weekEnd,
      payload: payload as unknown as object,
      model: payload.model,
    },
    update: {
      weekEnd,
      payload: payload as unknown as object,
      model: payload.model,
      generatedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'COMPETITOR_REPORT_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: {
      reportId: report.id,
      competitors: signal.length,
      model: payload.model,
    },
    ...requestMeta,
  });

  return report;
}

export async function listReports(companyId: string) {
  return db.competitorReport.findMany({
    where: { companyId },
    orderBy: { weekStart: 'desc' },
    take: 12,
  });
}

export async function getReport(companyId: string, reportId: string) {
  return db.competitorReport.findFirst({ where: { id: reportId, companyId } });
}
