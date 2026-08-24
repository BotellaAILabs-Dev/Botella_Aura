import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { discoveryCriteriaSchema } from '@/lib/validations/discovery';
import { discoverGitHubCompanies } from '@/server/leads/discovery/sources/github';
import { discoverCrunchbaseCompanies } from '@/server/leads/discovery/sources/crunchbase';
import { discoverPeopleFromSite } from '@/server/leads/discovery/sources/company-site';
import { discoverViaSearch } from '@/server/leads/discovery/sources/google-cse';
import { scoreLead } from '@/server/leads/discovery/scoring';
import {
  dedupeWithin,
  findExistingMatch,
} from '@/server/leads/discovery/dedup';
import { resolveCredential } from '@/server/connectors/connection.service';
import type { DiscoveredLead, DiscoveryCriteria } from '@/server/leads/discovery/types';

/**
 * Lead Discovery orchestrator (Sprint 5). Runs a DiscoveryProfile against the
 * public sources, dedupes candidates against each other AND existing leads,
 * creates new DISCOVERY_ENGINE leads, AI-scores them, and records a
 * DiscoveryRun. Idempotent-friendly: re-running merges into existing leads
 * rather than duplicating (NON-NEGOTIABLE #4).
 */
const MAX_COMPANIES_FOR_SITE = 8;
const MAX_NEW_LEADS = 25;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function runDiscovery(args: {
  companyId: string;
  profileId: string;
  userId?: string | null;
  requestMeta?: Meta;
}): Promise<{
  runId: string;
  leadsFound: number;
  leadsCreated: number;
  skipped: string[];
  category: string;
}> {
  const { companyId, profileId, userId, requestMeta } = args;

  const profile = await db.discoveryProfile.findFirst({
    where: { id: profileId, companyId },
  });
  if (!profile) throw new DiscoveryProfileNotFoundError();
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const criteria: DiscoveryCriteria = discoveryCriteriaSchema.parse(
    profile.criteria ?? {},
  );

  const run = await db.discoveryRun.create({
    data: { companyId, discoveryProfileId: profileId, status: 'RUNNING' },
  });
  await recordAudit({
    action: 'DISCOVERY_RUN_STARTED',
    userId: userId ?? null,
    companyId,
    metadata: { profileId, runId: run.id },
    ...requestMeta,
  });

  const skipped: string[] = [];
  const perSource: Record<string, number> = {};
  const leadCategory = profile.category?.trim() || profile.name;

  try {
    // Credentials come from this workspace's connectors when present, and fall
    // back to deployment-wide env vars — so connecting Crunchbase in the UI has
    // exactly the same effect as setting the key on the server.
    const [crunchbaseCred, cseCred] = await Promise.all([
      resolveCredential(companyId, 'crunchbase'),
      resolveCredential(companyId, 'google-cse'),
    ]);

    // 1) Companies from GitHub + Crunchbase; people from company sites.
    const [gh, cb, cse] = await Promise.all([
      discoverGitHubCompanies(criteria),
      discoverCrunchbaseCompanies(criteria, crunchbaseCred?.apiKey),
      discoverViaSearch(criteria, {
        apiKey: cseCred?.apiKey,
        cx: typeof cseCred?.metadata.cx === 'string' ? cseCred.metadata.cx : null,
      }),
    ]);
    if (gh.skipped) skipped.push(gh.skipped);
    if (cb.skipped) skipped.push(cb.skipped);
    if (cse.skipped) skipped.push(cse.skipped);

    const companies = [...gh.companies, ...cb.companies];
    const candidates: DiscoveredLead[] = [];

    // Company-level leads for every discovered org.
    for (const c of companies) {
      candidates.push({
        companyName: c.name,
        sourceUrl: c.sourceUrl,
        evidence: c.description,
        via: 'github/crunchbase',
      });
    }
    // People from company team pages (bounded, robots-gated).
    for (const c of companies.slice(0, MAX_COMPANIES_FOR_SITE)) {
      if (!c.website) continue;
      const people = await discoverPeopleFromSite(c.name, c.website);
      candidates.push(...people);
    }
    // Google CSE company-level leads.
    candidates.push(...cse.leads);

    perSource.github = gh.companies.length;
    perSource.crunchbase = cb.companies.length;
    perSource.googleCse = cse.leads.length;
    perSource.companySitePeople = candidates.filter((c) => c.via === 'company-site').length;

    // 2) Dedupe the batch, then against existing leads.
    const deduped = dedupeWithin(candidates);
    const existing = await db.lead.findMany({
      where: { companyId },
      select: { id: true, name: true, companyName: true },
    });

    let leadsCreated = 0;
    for (const cand of deduped) {
      const match = findExistingMatch(cand, existing);
      if (match) continue; // merge = keep the existing row (no duplicate)
      if (leadsCreated >= MAX_NEW_LEADS) break;

      const lead = await db.lead.create({
        data: {
          companyId,
          companyName: cand.companyName,
          name: cand.name ?? null,
          title: cand.title ?? null,
          sourceUrl: cand.sourceUrl ?? null,
          source: 'DISCOVERY_ENGINE',
          discoveryProfileId: profileId,
          // Snapshot the requirement this lead came from. Denormalized so the
          // label survives renaming or deleting the profile, and so leads from
          // different requirements stay separable everywhere downstream.
          category: leadCategory,
          status: 'NEW',
        },
      });
      existing.push({ id: lead.id, name: lead.name, companyName: lead.companyName });
      leadsCreated++;

      await recordAudit({
        action: 'LEAD_DISCOVERED',
        userId: userId ?? null,
        companyId,
        metadata: { leadId: lead.id, via: cand.via },
        ...requestMeta,
      });

      // 3) AI fit score, grounded in criteria + company ICP.
      const score = await scoreLead({ company, criteria, lead: cand });
      await db.lead.update({
        where: { id: lead.id },
        data: { fitScore: score.fitScore, fitRationale: score.fitRationale },
      });
      await recordAudit({
        action: 'LEAD_SCORED',
        userId: userId ?? null,
        companyId,
        metadata: { leadId: lead.id, fitScore: score.fitScore, model: score.model },
        ...requestMeta,
      });
    }

    const summary = {
      perSource,
      skipped,
      candidates: deduped.length,
      category: leadCategory,
    };
    await db.$transaction([
      db.discoveryRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          leadsFound: deduped.length,
          leadsCreated,
          summary,
          finishedAt: new Date(),
        },
      }),
      db.discoveryProfile.update({
        where: { id: profileId },
        data: { lastRunAt: new Date() },
      }),
    ]);
    await recordAudit({
      action: 'DISCOVERY_RUN_COMPLETED',
      userId: userId ?? null,
      companyId,
      metadata: { runId: run.id, leadsCreated, leadsFound: deduped.length },
      ...requestMeta,
    });

    return {
      runId: run.id,
      leadsFound: deduped.length,
      leadsCreated,
      skipped,
      category: leadCategory,
    };
  } catch (err) {
    logger.error('discovery: run failed', {
      profileId,
      error: err instanceof Error ? err.message : String(err),
    });
    await db.discoveryRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), summary: { skipped, error: String(err) } },
    });
    throw err;
  }
}

export class DiscoveryProfileNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Discovery profile not found.');
    this.name = 'DiscoveryProfileNotFoundError';
  }
}
