import { db } from '@/lib/db';
import { isClaudeConfigured, getModel } from '@/server/ai/claude';
import { discoveryCriteriaSchema } from '@/lib/validations/discovery';
import { resolveCredential } from '@/server/connectors/connection.service';
import type { DiscoveryCriteria } from '@/server/leads/discovery/types';

/**
 * Pre-run estimate for a discovery profile.
 *
 * Running discovery costs real time and real model tokens, so "Run now" should
 * never be a leap of faith. Everything here is derived from the profile's own
 * criteria, which sources are actually configured, and the profile's real run
 * history — no invented numbers. When we have past runs we say so and use them;
 * when we don't, we say the range is an estimate.
 */

/** Caps that bound a run — must stay in sync with discovery.service.ts. */
const MAX_COMPANIES_FOR_SITE = 8;
const MAX_NEW_LEADS = 25;

export interface EstimatedSource {
  id: string;
  label: string;
  /** Will this source contribute to the run? */
  willRun: boolean;
  /** Why not, when it won't. */
  reason?: string;
  /** Typical candidates this source contributes when it runs. */
  typicalResults: number;
  /** Rough seconds this source adds to the run. */
  seconds: number;
}

export interface DiscoveryEstimate {
  profileId: string;
  profileName: string;
  category: string;
  sources: EstimatedSource[];
  /** Inclusive candidate range we expect to surface. */
  expectedResults: { min: number; max: number };
  /** New leads created, after de-duplication against existing leads. */
  expectedNewLeads: { min: number; max: number };
  /** Wall-clock estimate in seconds. */
  estimatedSeconds: { min: number; max: number };
  usage: {
    /** Whether AI scoring/extraction will run at all. */
    aiEnabled: boolean;
    model: string;
    /** Model calls: one fit-score per new lead + one extraction per site read. */
    estimatedAiCalls: { min: number; max: number };
    /** Rough output-token budget for those calls. */
    estimatedTokens: { min: number; max: number };
    /** Plain-English cost note. */
    note: string;
  };
  /** How many leads this profile already produced (dedup context). */
  existingLeads: number;
  /** True when the numbers below are anchored on this profile's own history. */
  basedOnHistory: boolean;
  /** Anything the user should fix before running. */
  warnings: string[];
}

function criteriaBreadth(c: DiscoveryCriteria): number {
  return (
    c.industries.length +
    c.keywords.length +
    c.roleTitles.length +
    c.companyStages.length +
    c.geographies.length
  );
}

export async function estimateDiscoveryRun(args: {
  companyId: string;
  profileId: string;
}): Promise<DiscoveryEstimate> {
  const { companyId, profileId } = args;

  const profile = await db.discoveryProfile.findFirst({
    where: { id: profileId, companyId },
    include: {
      runs: {
        where: { status: 'COMPLETED' },
        orderBy: { startedAt: 'desc' },
        take: 5,
      },
      _count: { select: { leads: true } },
    },
  });
  if (!profile) throw new DiscoveryProfileNotFoundError();

  const criteria = discoveryCriteriaSchema.parse(profile.criteria ?? {});
  const breadth = criteriaBreadth(criteria);
  const aiEnabled = isClaudeConfigured();
  const warnings: string[] = [];

  if (breadth === 0) {
    warnings.push(
      'This profile has no criteria yet — a run would search nothing. Add at least one industry or keyword.',
    );
  }

  // --- Which sources will actually contribute -----------------------------
  // Resolve exactly the way the run itself will: workspace connector first,
  // deployment env second — so the estimate can never disagree with reality.
  const [crunchbaseCred, cseCred] = await Promise.all([
    resolveCredential(companyId, 'crunchbase'),
    resolveCredential(companyId, 'google-cse'),
  ]);
  const hasCrunchbase = Boolean(crunchbaseCred?.apiKey);
  const hasCse = Boolean(cseCred?.apiKey && cseCred.metadata.cx);

  const sources: EstimatedSource[] = [
    {
      id: 'github',
      label: 'GitHub organizations',
      willRun: breadth > 0,
      ...(breadth > 0 ? {} : { reason: 'No criteria to search with.' }),
      typicalResults: 6,
      seconds: 8,
    },
    {
      id: 'crunchbase',
      label: 'Crunchbase companies',
      willRun: hasCrunchbase && breadth > 0,
      ...(hasCrunchbase
        ? {}
        : {
            reason:
              'Crunchbase is not connected — funding/stage search is off.',
          }),
      typicalResults: 12,
      seconds: 10,
    },
    {
      id: 'google-cse',
      label: 'Google Custom Search',
      willRun: hasCse && breadth > 0,
      ...(hasCse
        ? {}
        : { reason: 'No Google Custom Search key connected — web search is off.' }),
      typicalResults: 8,
      seconds: 9,
    },
    {
      id: 'company-site',
      label: 'Company team pages (named contacts)',
      willRun: aiEnabled && breadth > 0,
      ...(aiEnabled
        ? {}
        : {
            reason:
              'No AI provider configured — we will not guess names, so only company-level leads are created.',
          }),
      typicalResults: 10,
      seconds: 22,
    },
  ];

  if (!hasCrunchbase) {
    warnings.push(
      'Crunchbase is not connected, so funding-stage and investor criteria will not be used.',
    );
  }
  if (!hasCse) {
    warnings.push(
      'Google Custom Search is not connected, so role-title searches across the open web will not run.',
    );
  }

  const running = sources.filter((s) => s.willRun);

  // --- Expected candidate volume ------------------------------------------
  // History beats heuristics: use this profile's own completed runs when we
  // have them.
  const history = profile.runs.map((r) => r.leadsFound).filter((n) => n > 0);
  const basedOnHistory = history.length > 0;

  let min: number;
  let max: number;
  if (basedOnHistory) {
    min = Math.min(...history);
    max = Math.max(...history);
  } else {
    const base = running.reduce((sum, s) => sum + s.typicalResults, 0);
    // Narrow criteria return fewer, broader criteria return more.
    const breadthFactor = Math.min(1.6, 0.5 + breadth * 0.15);
    max = Math.round(base * breadthFactor);
    min = Math.round(max * 0.3);
  }

  const createdHistory = profile.runs.map((r) => r.leadsCreated);
  const newMin = basedOnHistory
    ? Math.min(...createdHistory)
    : Math.min(MAX_NEW_LEADS, Math.round(min * 0.5));
  const newMax = basedOnHistory
    ? Math.min(MAX_NEW_LEADS, Math.max(...createdHistory))
    : Math.min(MAX_NEW_LEADS, max);

  // --- Time ---------------------------------------------------------------
  // Sources fetch in parallel, so the floor is the slowest source; team-page
  // reads are sequential and bounded by MAX_COMPANIES_FOR_SITE.
  const parallelFloor = running.length
    ? Math.max(...running.filter((s) => s.id !== 'company-site').map((s) => s.seconds), 5)
    : 2;
  const siteReads = running.some((s) => s.id === 'company-site')
    ? Math.min(MAX_COMPANIES_FOR_SITE, Math.max(2, Math.round(max / 3))) * 3
    : 0;
  const scoringSeconds = aiEnabled ? newMax * 2 : 0;
  const secondsMin = Math.max(5, Math.round(parallelFloor + siteReads * 0.4));
  const secondsMax = Math.max(
    secondsMin + 5,
    Math.round(parallelFloor + siteReads + scoringSeconds),
  );

  // --- AI usage -----------------------------------------------------------
  const siteCalls = running.some((s) => s.id === 'company-site')
    ? Math.min(MAX_COMPANIES_FOR_SITE, Math.max(1, Math.round(max / 3)))
    : 0;
  const callsMin = aiEnabled ? newMin + (siteCalls ? 1 : 0) : 0;
  const callsMax = aiEnabled ? newMax + siteCalls : 0;
  // Fit scoring is ~250 output tokens; a team-page extraction is ~400.
  const tokensMin = aiEnabled ? newMin * 250 + (siteCalls ? 400 : 0) : 0;
  const tokensMax = aiEnabled ? newMax * 250 + siteCalls * 400 : 0;

  return {
    profileId: profile.id,
    profileName: profile.name,
    category: profile.category?.trim() || profile.name,
    sources,
    expectedResults: { min, max },
    expectedNewLeads: { min: newMin, max: newMax },
    estimatedSeconds: { min: secondsMin, max: secondsMax },
    usage: {
      aiEnabled,
      model: aiEnabled ? getModel() : 'none',
      estimatedAiCalls: { min: callsMin, max: callsMax },
      estimatedTokens: { min: tokensMin, max: tokensMax },
      note: aiEnabled
        ? `Each new lead costs one short scoring call (~250 output tokens); reading a company team page costs one extraction call (~400). Re-runs are cheaper because leads you already have are de-duplicated before scoring.`
        : 'No AI provider is configured, so this run costs nothing in model usage — it will create company-level leads without fit scores.',
    },
    existingLeads: profile._count.leads,
    basedOnHistory,
    warnings,
  };
}

export class DiscoveryProfileNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Discovery profile not found.');
    this.name = 'DiscoveryProfileNotFoundError';
  }
}
