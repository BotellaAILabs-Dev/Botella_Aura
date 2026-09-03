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
 * AI fit-scoring. Scores a discovered lead 0-100 against the discovery
 * profile's criteria, grounded in the ACTING company's ICP/brand context, plus
 * a short "why this lead" rationale and the specific criteria it met or missed.
 * Deterministic fallback when Claude isn't configured — we never emit a
 * confident-sounding score with no basis.
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
        '. Score how well a lead fits the target criteria from 0-100. Also list ' +
        'which specific criteria the lead MEETS (`matched`) and which it does ' +
        'NOT (`missed`), naming the criterion verbatim. Give a ONE-sentence ' +
        'rationale grounded in the actual criteria + lead facts. Do not invent ' +
        'facts about the lead; if a criterion cannot be judged from the facts ' +
        'given, put it in `missed`. Respond with ONLY JSON: ' +
        '{"fitScore": number, "fitRationale": string, "matched": string[], "missed": string[]}.',
      prompt: [
        `Our company: ${company.name}. ${company.brandVoiceNotes ?? ''}`.trim(),
        `Target criteria: ${JSON.stringify(criteria)}`,
        `Lead: ${lead.name ? `${lead.name}, ` : ''}${lead.title ? `${lead.title}, ` : ''}at ${lead.companyName}. ${lead.evidence ?? ''}`.trim(),
      ].join('\n'),
      // Structured output plus two string arrays does not fit in 300 tokens;
      // a truncated response fails validation and drops every lead to the
      // deterministic floor, which is what made every score identical.
      maxTokens: 1000,
      effort: 'low',
      tier: 'cheap',
    });
    return { ...result, model: DEFAULT_MODEL };
  } catch (err) {
    logger.info('discovery/scoring: AI score failed, using deterministic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...deterministicScore(criteria, lead), model: 'none' };
  }
}

/** The criteria groups, weighted by how strongly each predicts a real fit. */
const GROUPS = [
  { key: 'industries', label: 'industry', weight: 30 },
  { key: 'roleTitles', label: 'role', weight: 25 },
  { key: 'keywords', label: 'keyword', weight: 20 },
  { key: 'companyStages', label: 'stage', weight: 15 },
  { key: 'geographies', label: 'geography', weight: 10 },
] as const;

/**
 * Term-overlap score used when Claude is unavailable.
 *
 * Previously this was `35 + hits * 15`, so every lead with no term match scored
 * exactly 35 — which is what produced a whole page of identical scores and the
 * uninformative "no explicit criteria match" note. Now each criteria group
 * contributes its own weight in proportion to how much of it the lead matches,
 * and a lead matching nothing scores low rather than landing on a flat floor.
 * Evidence-bearing leads get a small, clearly-bounded credit so "we found
 * something but cannot verify it" outranks "we found nothing".
 */
export function deterministicScore(
  criteria: DiscoveryCriteria,
  lead: DiscoveredLead,
): FitScore {
  const hay =
    `${lead.name ?? ''} ${lead.title ?? ''} ${lead.companyName} ${lead.evidence ?? ''}`.toLowerCase();

  const matched: string[] = [];
  const missed: string[] = [];
  let earned = 0;
  let available = 0;

  for (const group of GROUPS) {
    const terms = (criteria[group.key] ?? []).filter(Boolean);
    if (terms.length === 0) continue; // a criterion not stated cannot be missed
    available += group.weight;

    const hits = terms.filter((t) => hay.includes(t.toLowerCase()));
    if (hits.length > 0) {
      matched.push(...hits);
      // Partial credit: matching 1 of 3 stated industries is not a full match.
      earned += (group.weight * hits.length) / terms.length;
    } else {
      missed.push(`${group.label}: ${terms.slice(0, 3).join(', ')}`);
    }
  }

  // With no criteria stated at all there is nothing to score against, and
  // saying so is more honest than inventing a number.
  if (available === 0) {
    return {
      fitScore: 50,
      fitRationale:
        'No criteria were set on this requirement, so there is nothing to score against. Add industries, roles or keywords and re-run to get a real fit score.',
      matched: [],
      missed: [],
    };
  }

  const base = Math.round((earned / available) * 100);
  // Evidence is weak corroboration, not a criteria match — cap its influence.
  const evidenceBonus = lead.evidence && base > 0 ? 5 : 0;
  const fitScore = Math.max(0, Math.min(100, base + evidenceBonus));

  const fitRationale =
    matched.length > 0
      ? `Meets ${matched.length} of your criteria (${matched.slice(0, 4).join(', ')})${
          missed.length ? `; no match on ${missed.length} other${missed.length === 1 ? '' : 's'}` : ''
        }. Confirm the person before outreach.`
      : `No stated criterion matched the public information we found (${missed
          .slice(0, 3)
          .join('; ')}). Low confidence — review or refine your requirement.`;

  return { fitScore, fitRationale, matched, missed };
}
