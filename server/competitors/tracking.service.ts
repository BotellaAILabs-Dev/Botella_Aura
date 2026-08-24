import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { capturePage } from '@/server/competitors/sources/website';
import { fetchCompetitorNews } from '@/server/competitors/sources/news';
import { fetchGitHubSignal } from '@/server/competitors/sources/github';
import { fetchLinkedInCompanySignal } from '@/server/competitors/sources/linkedin';
import {
  diffTexts,
  hashText,
  summarizeChange,
  summarizePositioning,
} from '@/server/competitors/diff';
import type { ChangesSummary } from '@/server/competitors/types';

/**
 * Competitor tracking orchestrator (Sprint 4, Module 1). For each competitor it
 * captures the homepage/pricing pages (robots-respecting), diffs them against
 * the previous snapshot, gathers public news + GitHub signal, and persists a
 * CompetitorSnapshot with a human-readable `changesSummary`. Fully server-side;
 * touches no LinkedIn systems (that source is a flagged stub).
 */

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Capture + diff one page against a prior hash/text. */
interface TrackedPage {
  hash: string | null;
  text: string | null;
  changed: boolean;
  summary: string;
  model: string;
  skipped?: string;
  /** True when this is the first-ever capture of the page. */
  isBaseline?: boolean;
  /** What the page says today. Only produced on a baseline capture. */
  baseline?: string;
  /** True when the page was read successfully (used for coverage reporting). */
  read?: boolean;
}

async function trackPage(
  url: string | null,
  prevHash: string | null | undefined,
  prevText: string | null | undefined,
  competitorName: string,
  pageLabel: string,
): Promise<TrackedPage> {
  if (!url) return { hash: null, text: null, changed: false, summary: '', model: 'none' };

  const capture = await capturePage(url);
  if (!capture.ok || !capture.text) {
    return {
      hash: prevHash ?? null,
      text: prevText ?? null,
      changed: false,
      summary: '',
      model: 'none',
      skipped: `${pageLabel}: ${capture.reason ?? 'unavailable'}`,
    };
  }

  const hash = hashText(capture.text);
  const isFirst = !prevHash;
  const changed = !isFirst && hash !== prevHash;

  // First capture: there is nothing to diff against, so record what the page
  // says NOW. That gives the first weekly report real substance instead of an
  // empty "no activity detected" section.
  if (isFirst) {
    const { text: baseline, model } = await summarizePositioning({
      competitorName,
      pageLabel,
      pageText: capture.text,
    });
    return {
      hash,
      text: capture.text,
      changed: false,
      summary: '',
      model,
      isBaseline: true,
      baseline,
      read: true,
    };
  }

  if (!changed) {
    return {
      hash,
      text: capture.text,
      changed: false,
      summary: '',
      model: 'none',
      read: true,
    };
  }

  const diff = diffTexts(prevText, capture.text);
  const { text: summary, model } = await summarizeChange({
    competitorName,
    pageLabel,
    diff,
  });
  return { hash, text: capture.text, changed: true, summary, model, read: true };
}

/**
 * Run a full tracking pass for one competitor and persist a snapshot.
 * Returns the created snapshot id, or null if the competitor was skipped.
 */
export async function trackCompetitor(args: {
  competitorId: string;
  userId?: string | null;
  requestMeta?: Meta;
}): Promise<{ snapshotId: string; hasChanges: boolean } | null> {
  const { competitorId, userId, requestMeta } = args;

  const competitor = await db.competitorProfile.findUnique({
    where: { id: competitorId },
    include: { snapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } },
  });
  if (!competitor || !competitor.trackingEnabled) return null;

  const last = competitor.snapshots[0] ?? null;
  const skipped: string[] = [];

  const [homepage, pricing] = await Promise.all([
    trackPage(competitor.url, last?.homepageHash, last?.homepageText, competitor.name, 'homepage'),
    trackPage(competitor.pricingUrl, last?.pricingHash, last?.pricingText, competitor.name, 'pricing page'),
  ]);
  if (homepage.skipped) skipped.push(homepage.skipped);
  if (pricing.skipped) skipped.push(pricing.skipped);

  const news = await fetchCompetitorNews(competitor.name);

  const github = competitor.githubOrg
    ? await fetchGitHubSignal(competitor.githubOrg)
    : null;
  if (competitor.githubOrg && !github) {
    skipped.push('github: org not found or unreachable');
  }

  if (competitor.linkedInUrl) {
    const li = fetchLinkedInCompanySignal(competitor.linkedInUrl);
    if (!li.available) skipped.push(`linkedin: ${li.reason}`);
  }

  const usedModel =
    homepage.model !== 'none'
      ? homepage.model
      : pricing.model !== 'none'
        ? pricing.model
        : 'none';

  const isBaseline = Boolean(homepage.isBaseline || pricing.isBaseline);
  const baseline =
    homepage.baseline || pricing.baseline
      ? {
          ...(homepage.baseline ? { homepage: homepage.baseline } : {}),
          ...(pricing.baseline ? { pricing: pricing.baseline } : {}),
        }
      : undefined;

  const changesSummary: ChangesSummary = {
    hasChanges: homepage.changed || pricing.changed,
    homepage: homepage.summary || undefined,
    pricing: pricing.summary || undefined,
    news,
    github,
    skipped,
    model: usedModel,
    capturedAt: new Date().toISOString(),
    ...(isBaseline ? { isBaseline: true } : {}),
    ...(baseline ? { baseline } : {}),
  };

  const snapshot = await db.$transaction(async (tx) => {
    const snap = await tx.competitorSnapshot.create({
      data: {
        competitorId: competitor.id,
        homepageHash: homepage.hash,
        homepageText: homepage.text,
        pricingHash: pricing.hash,
        pricingText: pricing.text,
        changesSummary: changesSummary as unknown as object,
      },
    });
    await recordAudit(
      {
        action: 'COMPETITOR_SNAPSHOT_CAPTURED',
        userId: userId ?? null,
        companyId: competitor.companyId,
        metadata: {
          competitorId: competitor.id,
          hasChanges: changesSummary.hasChanges,
          newsCount: news.length,
        },
        ...requestMeta,
      },
      tx,
    );
    return snap;
  });

  return { snapshotId: snapshot.id, hasChanges: changesSummary.hasChanges };
}

/** Track every tracking-enabled competitor for a company (sequential, resilient). */
export async function trackCompany(
  companyId: string,
  opts?: { userId?: string | null; requestMeta?: Meta },
): Promise<{ tracked: number; changed: number; failed: number }> {
  const competitors = await db.competitorProfile.findMany({
    where: { companyId, trackingEnabled: true },
    select: { id: true },
  });

  let tracked = 0;
  let changed = 0;
  let failed = 0;
  for (const { id } of competitors) {
    try {
      const result = await trackCompetitor({
        competitorId: id,
        userId: opts?.userId ?? null,
        requestMeta: opts?.requestMeta,
      });
      if (result) {
        tracked++;
        if (result.hasChanges) changed++;
      }
    } catch (err) {
      failed++;
      logger.error('competitors: tracking failed for competitor', {
        competitorId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { tracked, changed, failed };
}
