import { describe, it, expect } from 'vitest';

import {
  DEFAULT_FILTERS,
  STATUS_INFO,
  countByGroup,
  detectedByLabel,
  filterOpportunities,
  nextStepFor,
  personTransitions,
  toOpportunityView,
  transitionLabel,
  type OpportunityRow,
} from '@/lib/opportunity-ui';
import { OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES } from '@/lib/opportunities';

/**
 * The Opportunities view: what each opportunity shows (why it exists, its
 * evidence traced to its source), how active and closed ones are told apart,
 * the next step, and filtering/sorting.
 */

const NOW = new Date('2026-10-03T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
let n = 0;

function row(o: Partial<OpportunityRow> = {}): OpportunityRow {
  n += 1;
  return {
    id: `o${n}`,
    type: 'COMPETITOR_MOVE',
    status: 'DETECTED',
    title: `Opportunity ${n}`,
    summary: 'Acme cut subscription prices.',
    rationale: 'A pricing change buyers will notice',
    angle: null,
    details: {},
    source: 'COMPETITORS',
    detectedBy: 'rule:competitor-move',
    priority: 'MEDIUM',
    priorityScore: 50,
    confidence: 'MEDIUM',
    confidenceReason: '1 high-reliability signal',
    detectedAt: days(-2),
    lastSeenAt: days(-1),
    relevantUntil: days(10),
    statusChangedAt: days(-2),
    decisionNote: null,
    expiredAt: null,
    signals: [],
    events: [],
    ...o,
  };
}

const evidence = (o: Partial<OpportunityRow['signals'][number]> = {}) => ({
  id: `e${(n += 1)}`,
  kind: 'COMPETITOR_SNAPSHOT' as const,
  refId: 'snap1',
  label: 'Acme Coffee',
  detail: 'Pricing change: subscriptions -20%',
  url: null,
  observedAt: days(-3),
  signalId: 'sig1',
  signal: {
    source: 'COMPETITORS' as const,
    reliability: 'HIGH' as const,
    reliabilityReason: 'seen directly on their site',
    occurrences: 2,
    expiresAt: days(20),
  },
  ...o,
});

describe('each opportunity explains why it exists', () => {
  it('shows the detector’s reasoning and a rule’s criteria, without repeats', () => {
    const v = toOpportunityView(
      row({
        rationale: 'Pricing change seen directly; within 30 days',
        details: {
          criteria: ['Pricing change seen directly', 'Competitor is tracked'],
        },
      }),
      NOW,
    );
    expect(v.why).toEqual([
      'Pricing change seen directly; within 30 days',
      'Competitor is tracked',
    ]);
    expect(v.confidenceReason).toBe('1 high-reliability signal');
  });

  it('does not repeat the summary when it is the reasoning itself', () => {
    const v = toOpportunityView(
      row({ summary: 'Same text', rationale: 'Same text' }),
      NOW,
    );
    expect(v.summary).toBeNull();
    expect(v.why[0]).toBe('Same text');
  });

  it('includes the advisor’s timing, and AI warnings', () => {
    const v = toOpportunityView(
      row({
        source: 'AI_DETECTION',
        details: {
          timing: 'This week',
          ai: { warnings: ['model rated it HIGH; lowered to MEDIUM'] },
        },
      }),
      NOW,
    );
    expect(v.why).toContain('Timing: This week');
    expect(v.warnings).toEqual(['model rated it HIGH; lowered to MEDIUM']);
  });

  it('names the source and what detected it', () => {
    expect(detectedByLabel('rule:trending-topic')).toBe('Rule: trending topic');
    expect(detectedByLabel('ai:claude-sonnet-5')).toBe(
      'AI analysis (claude-sonnet-5)',
    );
    expect(detectedByLabel('deterministic')).toBe('Advisor rules (no AI)');
    expect(
      toOpportunityView(row({ source: 'AI_DETECTION' }), NOW).sourceLabel,
    ).toBe('AI analysis');
  });
});

describe('evidence can be traced back to its signal and source', () => {
  it('links each piece of evidence to its page in Aura, the original, and its signal', () => {
    const v = toOpportunityView(
      row({
        signals: [
          evidence(),
          evidence({
            kind: 'TREND_ITEM',
            url: 'https://news.example/story',
            signal: null,
            signalId: null,
          }),
        ],
      }),
      NOW,
    );
    const [comp, trend] = v.evidence;
    expect(comp!.sourcePage).toEqual({
      href: '/dashboard/competitors',
      label: 'Open in Competitors',
    });
    expect(comp!.signal).toMatchObject({
      id: 'sig1',
      source: 'Competitors',
      reliability: 'HIGH',
      occurrences: 2,
      expired: false,
    });
    expect(trend!.sourcePage?.href).toBe('/dashboard/trends');
    expect(trend!.externalUrl).toBe('https://news.example/story');
    expect(trend!.signal).toBeNull();
  });

  it('says when the underlying signal has been pruned or is out of date', () => {
    const v = toOpportunityView(
      row({
        signals: [
          evidence({ signal: null }),
          evidence({
            signalId: 'sig2',
            signal: { ...evidence().signal!, expiresAt: days(-1) },
          }),
        ],
      }),
      NOW,
    );
    expect(v.evidence[0]!.signalRemoved).toBe(true);
    expect(v.evidence[1]!.signal?.expired).toBe(true);
  });

  it('shows how an AI opportunity said each signal supports it', () => {
    const v = toOpportunityView(
      row({
        signals: [evidence()],
        details: {
          ai: {
            evidence: [{ signalId: 'sig1', supports: 'Acme cut prices.' }],
          },
        },
      }),
      NOW,
    );
    expect(v.evidence[0]!.supports).toBe('Acme cut prices.');
  });

  it('never links an unsafe URL', () => {
    const v = toOpportunityView(
      row({ signals: [evidence({ url: 'javascript:alert(1)' })] }),
      NOW,
    );
    expect(v.evidence[0]!.externalUrl).toBeNull();
  });
});

describe('active vs expired/rejected', () => {
  it('puts every status in exactly one group', () => {
    const groups = OPPORTUNITY_STATUSES.map((s) => STATUS_INFO[s].group);
    expect(groups).toEqual([
      'active',
      'active',
      'active',
      'accepted',
      'closed',
      'closed',
    ]);
  });

  it('counts days left only while open', () => {
    expect(
      toOpportunityView(row({ relevantUntil: days(5) }), NOW).daysLeft,
    ).toBe(5);
    expect(
      toOpportunityView(
        row({ status: 'EXPIRED', relevantUntil: days(-1) }),
        NOW,
      ).daysLeft,
    ).toBeNull();
    expect(
      toOpportunityView(row({ relevantUntil: null }), NOW).daysLeft,
    ).toBeNull();
  });

  it('shows open ones by default, and counts each group', () => {
    const list = [
      row({ status: 'DETECTED' }),
      row({ status: 'RECOMMENDED' }),
      row({ status: 'ACCEPTED' }),
      row({ status: 'REJECTED' }),
      row({ status: 'EXPIRED' }),
    ].map((r) => toOpportunityView(r, NOW));
    expect(
      filterOpportunities(list, DEFAULT_FILTERS).map((o) => o.status),
    ).toEqual(expect.arrayContaining(['DETECTED', 'RECOMMENDED']));
    expect(filterOpportunities(list, DEFAULT_FILTERS)).toHaveLength(2);
    expect(
      filterOpportunities(list, { ...DEFAULT_FILTERS, status: 'closed' }).map(
        (o) => o.status,
      ),
    ).toEqual(expect.arrayContaining(['REJECTED', 'EXPIRED']));
    expect(countByGroup(list)).toEqual({
      active: 2,
      accepted: 1,
      closed: 2,
      all: 5,
    });
  });
});

describe('status actions and next step', () => {
  it('offers only lifecycle moves a person makes — never “expire”', () => {
    const v = toOpportunityView(row({ status: 'DETECTED' }), NOW);
    expect(personTransitions(v)).toEqual([
      'REVIEWED',
      'RECOMMENDED',
      'ACCEPTED',
      'REJECTED',
    ]);
    expect(
      personTransitions(toOpportunityView(row({ status: 'EXPIRED' }), NOW)),
    ).toEqual([]);
    expect(transitionLabel('REJECTED', 'REVIEWED')).toBe('Reopen');
    expect(transitionLabel('DETECTED', 'REVIEWED')).toBe('Mark reviewed');
  });

  it('gives every type and status a next step', () => {
    for (const type of OPPORTUNITY_TYPES) {
      for (const status of OPPORTUNITY_STATUSES) {
        const step = nextStepFor({ type, status, title: 'T', angle: null });
        expect(step.text.length).toBeGreaterThan(5);
        if (status === 'ACCEPTED') expect(step.link).not.toBeNull();
      }
    }
  });

  it('sends an accepted content opportunity straight to a draft with its brief', () => {
    const step = nextStepFor({
      type: 'TRENDING_TOPIC',
      status: 'ACCEPTED',
      title: 'Specialty coffee prices',
      angle: 'Explain the harvest',
    });
    expect(step.link?.href).toBe(
      `/dashboard/content/new?brief=${encodeURIComponent('Specialty coffee prices\n\nAngle: Explain the harvest')}`,
    );
    expect(
      nextStepFor({
        type: 'CHANNEL',
        status: 'ACCEPTED',
        title: 'x',
        angle: null,
      }).link?.href,
    ).toBe('/dashboard/connectors');
  });
});

describe('filtering and sorting', () => {
  const list = [
    row({
      priority: 'LOW',
      priorityScore: 20,
      detectedAt: days(-1),
      relevantUntil: days(3),
      confidence: 'HIGH',
    }),
    row({
      priority: 'URGENT',
      priorityScore: 90,
      detectedAt: days(-5),
      relevantUntil: null,
      type: 'TRENDING_TOPIC',
      source: 'TRENDS',
      confidence: 'LOW',
    }),
    row({
      priority: 'HIGH',
      priorityScore: 70,
      detectedAt: days(-3),
      relevantUntil: days(8),
      source: 'AI_DETECTION',
      type: 'CONTENT_GAP',
    }),
  ].map((r) => toOpportunityView(r, NOW));
  const order = (sort: (typeof DEFAULT_FILTERS)['sort']) =>
    filterOpportunities([...list], { ...DEFAULT_FILTERS, sort }).map(
      (o) => o.priority,
    );

  it('sorts by priority, newest, closing soonest and confidence', () => {
    expect(order('priority')).toEqual(['URGENT', 'HIGH', 'LOW']);
    expect(order('newest')).toEqual(['LOW', 'HIGH', 'URGENT']);
    // No expiry sorts last.
    expect(order('closing')).toEqual(['LOW', 'HIGH', 'URGENT']);
    expect(order('confidence')).toEqual(['LOW', 'HIGH', 'URGENT']);
  });

  it('lists open ones before decided and closed ones, whatever the sort', () => {
    const mixed = [
      row({ status: 'REJECTED', priority: 'URGENT', priorityScore: 99 }),
      row({ status: 'ACCEPTED', priority: 'HIGH', priorityScore: 80 }),
      row({ status: 'DETECTED', priority: 'LOW', priorityScore: 10 }),
    ].map((r) => toOpportunityView(r, NOW));
    expect(
      filterOpportunities(mixed, { ...DEFAULT_FILTERS, status: 'all' }).map(
        (o) => o.status,
      ),
    ).toEqual(['DETECTED', 'ACCEPTED', 'REJECTED']);
  });

  it('filters by type and source', () => {
    expect(
      filterOpportunities(list, { ...DEFAULT_FILTERS, type: 'TRENDING_TOPIC' }),
    ).toHaveLength(1);
    expect(
      filterOpportunities(list, {
        ...DEFAULT_FILTERS,
        source: 'AI_DETECTION',
      })[0]?.type,
    ).toBe('CONTENT_GAP');
  });
});
