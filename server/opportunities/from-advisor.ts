import type {
  CampaignOpportunity,
  OpportunityEvidence,
} from '@/server/advisor/types';
import type {
  OpportunityInput,
  OpportunityType,
  SignalInput,
} from '@/lib/opportunities';

/**
 * Advisor output → stored opportunities.
 *
 * The advisor writes its opportunities into a daily report for display; this
 * turns each one into an Opportunity row with its evidence linked to the
 * records it came from, so it can be tracked, reviewed and later recommended
 * independently of that report.
 */

/** What kind of opening the advisor found, judged from its evidence. */
export function advisorOpportunityType(
  o: CampaignOpportunity,
): OpportunityType {
  const kinds = new Set(o.evidence.map((e) => e.kind));
  if (o.inspiredBy || kinds.has('competitor')) return 'COMPETITOR_MOVE';
  if (kinds.has('trend')) return 'TRENDING_TOPIC';
  if (kinds.has('memory') || kinds.has('performance'))
    return 'PERFORMANCE_PATTERN';
  if (kinds.has('gap')) return 'CONTENT_GAP';
  return 'OTHER';
}

function toSignal(e: OpportunityEvidence): SignalInput {
  return {
    // Evidence the advisor could not tie to a record is still evidence, but
    // marked EXTERNAL rather than pretending to a link it does not have.
    kind: e.signal?.kind ?? 'EXTERNAL',
    refId: e.signal?.refId ?? null,
    label: e.label.slice(0, 200),
    detail: e.detail.slice(0, 2000),
    ...(e.url && /^https?:\/\//i.test(e.url) ? { url: e.url } : {}),
    ...(e.signal?.observedAt
      ? { observedAt: new Date(e.signal.observedAt) }
      : {}),
  };
}

export function advisorToOpportunityInput(
  o: CampaignOpportunity,
  model: string,
): OpportunityInput {
  return {
    type: advisorOpportunityType(o),
    title: o.title,
    summary: o.rationale,
    rationale: o.rationale,
    angle: o.angle,
    details: {
      channels: o.channels,
      contentIdeas: o.contentIdeas,
      timing: o.timing,
      ...(o.inspiredBy ? { inspiredBy: o.inspiredBy } : {}),
    },
    source: 'ADVISOR',
    detectedBy: model === 'none' ? 'deterministic' : model,
    signals: o.evidence.map(toSignal),
    impact: o.impact,
    effort: o.effort,
    // The advisor aims every opportunity at the stated reader of a described
    // business; if those are guesses, so is the opportunity.
    contextFields: [
      'identity.description',
      'audience.stated',
      'audience.marketMode',
    ],
  };
}
