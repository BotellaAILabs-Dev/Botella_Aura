import type { Company } from '@prisma/client';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { fitScoreSchema, type FitScore } from '@/lib/validations/discovery';
import { logger } from '@/lib/logger';
import type { DiscoveredLead, DiscoveryCriteria } from '@/server/leads/discovery/types';

/**
 * AI fit-scoring (Sprint 5). Scores a discovered lead 0-100 against the
 * discovery profile's criteria, grounded in the ACTING company's ICP/brand
 * context (same grounding pattern used across the product), plus a short "why
 * this lead" rationale. Deterministic fallback when Claude isn't configured —
 * we never emit a confident-sounding score with no basis.
 */
export async function scoreLead(args: {
  company: Company;
  criteria: DiscoveryCriteria;
  lead: DiscoveredLead;
}): Promise<FitScore & { model: string }> {
  const { company, criteria, lead } = args;

  if (!isClaudeConfigured()) {
    return { ...deterministicScore(criteria, lead), model: 'none' };
  }

  try {
    const result = await completeStructured({
      schema: fitScoreSchema,
      system:
        `You qualify sales leads for ${company.name}` +
        (company.industry ? ` (industry: ${company.industry})` : '') +
        '. Score how well a lead fits the target criteria from 0-100 and give a ' +
        'ONE-sentence rationale grounded in the actual criteria + lead facts. ' +
        'Do not invent facts about the lead. Respond with ONLY JSON: ' +
        '{"fitScore": number, "fitRationale": string}.',
      prompt: [
        `Our company: ${company.name}. ${company.brandVoiceNotes ?? ''}`.trim(),
        `Target criteria: ${JSON.stringify(criteria)}`,
        `Lead: ${lead.name ? `${lead.name}, ` : ''}${lead.title ? `${lead.title}, ` : ''}at ${lead.companyName}. ${lead.evidence ?? ''}`.trim(),
      ].join('\n'),
      maxTokens: 300,
      effort: 'low',
    });
    return { ...result, model: DEFAULT_MODEL };
  } catch (err) {
    logger.info('discovery/scoring: AI score failed, using deterministic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...deterministicScore(criteria, lead), model: 'none' };
  }
}

/** Term-overlap score used when Claude is unavailable. */
export function deterministicScore(
  criteria: DiscoveryCriteria,
  lead: DiscoveredLead,
): FitScore {
  const terms = [
    ...criteria.industries,
    ...criteria.roleTitles,
    ...criteria.companyStages,
    ...criteria.keywords,
    ...criteria.geographies,
  ].map((t) => t.toLowerCase());
  const hay = `${lead.name ?? ''} ${lead.title ?? ''} ${lead.companyName} ${lead.evidence ?? ''}`.toLowerCase();
  const hits = terms.filter((t) => t && hay.includes(t));
  const uniqueHits = Array.from(new Set(hits));
  const fitScore = Math.min(100, 35 + uniqueHits.length * 15);
  const fitRationale = uniqueHits.length
    ? `Matches ${uniqueHits.length} of your criteria (${uniqueHits.slice(0, 4).join(', ')}). Confirm the person before outreach.`
    : 'Surfaced by discovery but no explicit criteria match — review manually.';
  return { fitScore, fitRationale };
}
