import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { ensureOutreachConfig, toCriteria } from '@/server/outreach/config.service';
import { filterSignals } from '@/server/outreach/matching';
import { githubSignals } from '@/server/outreach/sources/github';
import { newsSignals } from '@/server/outreach/sources/news';
import { jobSignals } from '@/server/outreach/sources/jobs';
import { crunchbaseSignals } from '@/server/outreach/sources/crunchbase';
import { resolveCredential } from '@/server/connectors/connection.service';
import type { RawSignal } from '@/server/outreach/types';

/**
 * Lead-signal detection orchestrator (Sprint 4, Module 3). Runs the enabled
 * PUBLIC sources against the company's criteria, filters + dedupes, then upserts
 * a Lead per target company and attaches a LeadSignal. Company-granularity —
 * the user confirms the actual person. Fully server-side; touches no LinkedIn.
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function detectForCompany(args: {
  companyId: string;
  userId?: string | null;
  requestMeta?: Meta;
}): Promise<{ leadsCreated: number; signalsAdded: number; skipped: string[] }> {
  const { companyId, userId, requestMeta } = args;
  const config = await ensureOutreachConfig(companyId);
  const criteria = toCriteria(config);
  const terms = [...criteria.industries, ...criteria.companyStages];
  const skipped: string[] = [];

  const tasks: Promise<RawSignal[]>[] = [];
  if (criteria.enabledSources.github && terms.length) tasks.push(githubSignals(terms));
  if (criteria.enabledSources.news && terms.length) tasks.push(newsSignals(terms));
  if (criteria.enabledSources.jobs && criteria.roleTitles.length)
    tasks.push(jobSignals(criteria.roleTitles));

  if (criteria.enabledSources.crunchbase) {
    // Workspace Crunchbase connector, falling back to the deployment env var.
    const cred = await resolveCredential(companyId, 'crunchbase');
    const cb = await crunchbaseSignals(terms, cred?.apiKey);
    if (!cb.available && cb.reason) skipped.push(`crunchbase: ${cb.reason}`);
    tasks.push(Promise.resolve(cb.signals));
  } else {
    skipped.push('crunchbase: disabled');
  }

  if (!terms.length && !criteria.roleTitles.length) {
    skipped.push('no targeting criteria set — add industries/keywords/role titles in settings');
  }

  const settled = await Promise.allSettled(tasks);
  const raw: RawSignal[] = [];
  for (const s of settled) if (s.status === 'fulfilled') raw.push(...s.value);

  const signals = filterSignals(raw, criteria);

  let leadsCreated = 0;
  let signalsAdded = 0;

  for (const sig of signals) {
    try {
      const existing = await db.lead.findFirst({
        where: { companyId, companyName: sig.companyName },
      });
      const lead =
        existing ??
        (await db.lead.create({
          data: {
            companyId,
            companyName: sig.companyName,
            sourceUrl: sig.sourceUrl ?? null,
            status: 'NEW',
          },
        }));
      if (!existing) {
        leadsCreated++;
        await recordAudit({
          action: 'LEAD_CREATED',
          userId: userId ?? null,
          companyId,
          metadata: { leadId: lead.id, companyName: lead.companyName },
          ...requestMeta,
        });
      }

      // Avoid duplicate identical signals for a lead.
      const dupe = await db.leadSignal.findFirst({
        where: { leadId: lead.id, description: sig.description },
      });
      if (dupe) continue;

      await db.leadSignal.create({
        data: {
          leadId: lead.id,
          signalType: sig.signalType,
          description: sig.description,
          sourceUrl: sig.sourceUrl ?? null,
        },
      });
      signalsAdded++;
    } catch (err) {
      logger.warn('outreach/detect: failed to persist signal', {
        companyName: sig.companyName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await recordAudit({
    action: 'LEAD_SIGNAL_DETECTED',
    userId: userId ?? null,
    companyId,
    metadata: { leadsCreated, signalsAdded, sources: criteria.enabledSources },
    ...requestMeta,
  });

  return { leadsCreated, signalsAdded, skipped };
}
