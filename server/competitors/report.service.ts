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
  CompetitorCoverage,
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
  /** First-capture positioning summaries — real content for the first report. */
  baseline: string[];
  coverage: CompetitorCoverage;
}

/** Does this competitor have anything at all worth putting in a section? */
function hasSignal(s: CompetitorSignal): boolean {
  return Boolean(
    s.homepageChanges.length ||
      s.pricingChanges.length ||
      s.news.length ||
      s.github.length ||
      s.baseline.length,
  );
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
    const baseline: string[] = [];
    const seenNews = new Set<string>();
    const checked = new Set<string>();
    const skipped = new Set<string>();
    let baselineOnly = c.snapshots.length > 0;
    let lastCapturedAt: string | undefined;

    for (const snap of c.snapshots) {
      const s = snap.changesSummary as ChangesSummary;
      if (!s) continue;
      if (s.capturedAt) lastCapturedAt = s.capturedAt;
      if (!s.isBaseline) baselineOnly = false;

      if (s.homepage) {
        homepageChanges.push(s.homepage);
        checked.add('homepage');
      }
      if (s.pricing) {
        pricingChanges.push(s.pricing);
        checked.add('pricing page');
      }
      if (s.baseline?.homepage) {
        baseline.push(s.baseline.homepage);
        checked.add('homepage');
      }
      if (s.baseline?.pricing) {
        baseline.push(s.baseline.pricing);
        checked.add('pricing page');
      }
      for (const n of s.news ?? []) {
        checked.add('news');
        if (!seenNews.has(n.url)) {
          seenNews.add(n.url);
          news.push({ title: n.title, url: n.url });
        }
      }
      // GitHub is a real product-movement signal — surface releases AND recent
      // pushes, not just tagged releases (most orgs ship without tagging).
      if (s.github) {
        checked.add('github');
        if (s.github.latestRelease) {
          github.push(
            `Release ${s.github.latestRelease.name} in ${s.github.latestRelease.repo}`,
          );
        }
        for (const repo of (s.github.recentlyPushed ?? []).slice(0, 3)) {
          github.push(
            `Active development in ${repo.repo} (last push ${new Date(
              repo.pushedAt,
            ).toLocaleDateString()})`,
          );
        }
      }
      for (const reason of s.skipped ?? []) skipped.add(reason);
    }

    return {
      id: c.id,
      name: c.name,
      homepageChanges,
      pricingChanges,
      news,
      github: [...new Set(github)],
      baseline: [...new Set(baseline)],
      coverage: {
        snapshots: c.snapshots.length,
        checked: [...checked],
        skipped: [...skipped],
        baselineOnly,
        ...(lastCapturedAt ? { lastCapturedAt } : {}),
      },
    };
  });
}

/**
 * The honest explanation for an empty section. "No material public activity"
 * on its own reads like a failure; these say what was actually checked and why
 * there is nothing yet.
 */
function emptyTakeaway(s: CompetitorSignal): string {
  if (s.coverage.snapshots === 0) {
    return 'Not tracked yet this week - run "Generate now" (or wait for the weekly job) to capture a first snapshot.';
  }
  if (s.coverage.baselineOnly) {
    return 'First snapshot captured - this is the baseline we will compare against, so changes start appearing from the next run.';
  }
  if (s.coverage.skipped.length) {
    return `We checked ${s.coverage.checked.join(', ') || 'the configured sources'} and found no changes. Some sources were unavailable: ${s.coverage.skipped.join('; ')}.`;
  }
  return `We checked ${s.coverage.checked.join(', ') || 'the configured sources'} and nothing material changed this week.`;
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
    notableActivity: [
      ...s.homepageChanges,
      ...s.baseline,
      ...s.news.slice(3, 6).map((n) => n.title),
    ],
    strategicTakeaway: hasSignal(s)
      ? 'Review the detected changes and consider whether your positioning or pricing needs a response.'
      : emptyTakeaway(s),
    coverage: s.coverage,
  }));
  const active = signal.filter(hasSignal);
  const synthesis = active.length
    ? `${active.length} of ${signal.length} tracked competitors showed public activity this week: ${active
        .map((s) => s.name)
        .join(', ')}. Review the details and decide where to respond.`
    : signal.length === 0
      ? 'No competitors are being tracked yet. Add a competitor to start building a weekly picture of their public moves.'
      : `We checked all ${signal.length} tracked competitor(s) and nothing material changed this week. That is a real result, not an error - each section below says exactly what was checked.`;
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
    return {
      competitors: entries,
      synthesis,
      model: 'none',
      ...(signal.length === 0 ? { noCompetitors: true } : {}),
      ...base,
    };
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
          s.baseline.length
            ? `  Current positioning (first capture): ${s.baseline.join(' | ')}`
            : '',
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
      const notableActivity = match?.notableActivity ?? [];
      // Never let the model's omission hide a real baseline we captured.
      for (const b of s.baseline) {
        if (!notableActivity.some((a) => a.includes(b.slice(0, 40)))) {
          notableActivity.push(b);
        }
      }
      const empty =
        !(match?.newLaunches ?? []).length &&
        !(match?.pricingChanges ?? []).length &&
        !notableActivity.length;
      return {
        competitorId: s.id,
        competitor: s.name,
        newLaunches: match?.newLaunches ?? [],
        pricingChanges: match?.pricingChanges ?? [],
        notableActivity,
        strategicTakeaway: empty
          ? emptyTakeaway(s)
          : (match?.strategicTakeaway ??
            'Review the detected changes and decide whether to respond.'),
        coverage: s.coverage,
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
