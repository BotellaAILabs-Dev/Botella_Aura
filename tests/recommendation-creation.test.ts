import { describe, it, expect } from 'vitest';

import {
  creationPlan,
  creationProvenance,
  planBriefFrom,
  provenancePrompt,
  type CreatableRecommendation,
} from '@/lib/recommendation-creation';
import {
  buildContextHandoff,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';
import {
  CREATION_KIND,
  ROUTE_BY_ACTION,
  ROUTE_BY_TYPE,
} from '@/lib/aura-modules';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import { planInputsSchema } from '@/lib/validations/planner';
import type {
  RecommendationStatus,
  RecommendationType,
} from '@/lib/recommendations';

/**
 * Recommendation → creation: what "Create" means for each kind of
 * recommendation, whether it can happen now, and what the created piece keeps.
 */

function rec(
  over: Partial<CreatableRecommendation> & { engineAction?: string } = {},
): CreatableRecommendation {
  const { engineAction = 'response-post', ...rest } = over;
  return {
    id: 'rec1',
    type: 'COMPETITIVE_RESPONSE',
    title: 'Respond to Acme’s fall bourbon promotion',
    action: 'Publish a post on LinkedIn giving your own view on this.',
    steps: ['Lead with curation'],
    rationale: 'Acme discounted its fall bourbon line.',
    expectedOutcome: 'Buyers comparing options hear your position.',
    channel: 'LinkedIn',
    contentType: 'LINKEDIN_POST',
    audience: 'Local whiskey fans',
    details: { action: engineAction },
    status: 'ACCEPTED',
    blockers: [],
    ...rest,
  };
}

const NOW = new Date('2026-10-09T12:00:00Z');
function handoff(
  r: Partial<HandoffInput['recommendation']> = {},
  b: Partial<HandoffInput['business']> = {},
) {
  return buildContextHandoff({
    recommendation: {
      id: 'rec1',
      opportunityId: 'opp1',
      status: 'ACCEPTED',
      type: 'COMPETITIVE_RESPONSE',
      title: 'Respond to Acme’s fall bourbon promotion',
      action: 'Publish a post on LinkedIn giving your own view on this.',
      steps: ['Lead with curation'],
      rationale:
        'Acme discounted its fall bourbon line. Based on 1 piece of evidence: Acme cut prices.',
      expectedOutcome: 'Buyers comparing options hear your position.',
      outcomeMetric: 'engagement',
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: 'Local whiskey fans',
      details: { action: 'response-post', angle: 'Curation, not price' },
      confidence: 'HIGH',
      confidenceReason: 'Seen on their pricing page',
      executable: true,
      blockers: [],
      evidence: [
        {
          label: 'Acme cut bourbon prices',
          detail: '15% off.',
          url: 'https://acme.example/pricing',
          observedAt: new Date('2026-10-04T00:00:00Z'),
        },
      ],
      ...r,
    },
    business: {
      name: 'Botella',
      description: 'A neighbourhood bottle shop with a curated spirits list.',
      offerings: null,
      industry: 'Retail',
      website: 'https://botella.example',
      goals: 'Grow tasting-event bookings',
      audience: 'Spirits enthusiasts in the city',
      campaigns: [],
      connected: ['LinkedIn'],
      voice: null,
      memory: [],
      ...b,
    },
    now: NOW,
  });
}

describe('which recommendations create what', () => {
  const CONTENT = [
    'post',
    'article',
    'response-post',
    'comparison-article',
    'targeted-post',
    'recovery-post',
  ];
  const WORKFLOW = ['series', 'apply-pattern', 'plan-it'];
  const ACTION = ['update-audience', 'connect-channel'];

  it('every engine action is classified — content, another workflow, or no creation', () => {
    expect([...CONTENT, ...WORKFLOW, ...ACTION].sort()).toEqual(
      Object.keys(ROUTE_BY_ACTION).sort(),
    );
  });

  it.each(CONTENT)('%s creates a content draft in Content Studio', (a) => {
    const p = creationPlan(rec({ engineAction: a }));
    expect(p).toMatchObject({
      kind: 'content',
      module: 'content-studio',
      creates: 'a content draft',
    });
    expect(p.href).toMatch(/^\/dashboard\/content\/new\?rec=rec1/);
  });

  it.each(WORKFLOW)('%s opens another Aura workflow that creates', (a) => {
    const p = creationPlan(rec({ engineAction: a }));
    expect(p.kind).toBe('workflow');
    expect(['campaigns', 'content-plan']).toContain(p.module);
    expect(p.creates).toMatch(/plan/);
    expect(p.href).toContain('rec=rec1');
  });

  it.each(ACTION)('%s creates nothing, and says where it is done', (a) => {
    const p = creationPlan(rec({ engineAction: a, status: 'PRESENTED' }));
    expect(p).toMatchObject({
      kind: 'action',
      state: 'not_creatable',
      canCreate: false,
      creates: null,
    });
    expect(p.message).toMatch(/doesn’t need new content — it’s done in/);
    expect(p.fix?.href).toBe(p.href);
  });

  it('falls back to the type when the engine’s action is unknown', () => {
    for (const type of Object.keys(ROUTE_BY_TYPE) as RecommendationType[]) {
      const p = creationPlan(rec({ type, details: {} }));
      expect(p.kind).toBe(CREATION_KIND[ROUTE_BY_TYPE[type].primary]);
    }
  });

  it('a related workflow that creates can be used (one piece of a planned series)', () => {
    const p = creationPlan(rec({ engineAction: 'series' }), {
      module: 'content-studio',
    });
    expect(p).toMatchObject({
      module: 'content-studio',
      state: 'ready',
      canCreate: true,
      creates: 'a content draft',
    });
  });

  it('an action suggestion has nothing to write, even opened in Content Studio', () => {
    const p = creationPlan(rec({ engineAction: 'connect-channel' }), {
      module: 'content-studio',
    });
    expect(p.state).toBe('not_creatable');
    expect(p.fix?.label).toMatch(/^Connect/);
  });
});

describe('whether it can be created from now', () => {
  it('accepted, edited or in progress: ready', () => {
    for (const status of [
      'ACCEPTED',
      'EDITED',
      'IN_PROGRESS',
    ] as RecommendationStatus[]) {
      expect(creationPlan(rec({ status }))).toMatchObject({
        state: 'ready',
        canCreate: true,
        acceptsOnCreate: false,
        message: null,
      });
    }
  });

  it('still open: creating says yes to it', () => {
    for (const status of ['GENERATED', 'PRESENTED'] as RecommendationStatus[]) {
      const p = creationPlan(rec({ status }));
      expect(p).toMatchObject({
        state: 'accept_first',
        canCreate: true,
        acceptsOnCreate: true,
      });
      expect(p.message).toMatch(/also says yes/);
    }
  });

  it('low confidence is not in the way — saying yes is its review', () => {
    const p = creationPlan(
      rec({ status: 'PRESENTED', blockers: [LOW_CONFIDENCE_BLOCKER] }),
    );
    expect(p.state).toBe('accept_first');
  });

  it('a channel the business does not use: needs info, with where to fix it', () => {
    const p = creationPlan(
      rec({ blockers: ['TikTok is not a channel the business uses.'] }),
    );
    expect(p).toMatchObject({ state: 'needs_info', canCreate: false });
    expect(p.message).toMatch(/You don’t post on TikTok/);
    expect(p.fix).toEqual({
      label: 'Edit the suggestion',
      href: '/dashboard/suggestions',
    });
  });

  it('required business information missing: needs info, with the question to answer', () => {
    const h = handoff({}, { description: null });
    const p = creationPlan(rec(), { handoff: h });
    expect(p.state).toBe('needs_info');
    expect(p.fix?.href).toMatch(/^\/dashboard\/business/);
  });

  it('recommended gaps do not stop creation — they are stated, not filled', () => {
    const h = handoff({}, { goals: null });
    expect(h.missing.some((m) => m.field === 'goal')).toBe(true);
    expect(creationPlan(rec(), { handoff: h }).state).toBe('ready');
  });

  it('skipped, turned down, withdrawn, expired or done: closed, plainly', () => {
    const words: Record<string, RegExp> = {
      SKIPPED: /You skipped this suggestion/,
      REJECTED: /You turned this suggestion down/,
      WITHDRAWN: /withdrawn/,
      EXPIRED: /expired/,
      COMPLETED: /already done/,
    };
    for (const [status, re] of Object.entries(words)) {
      const p = creationPlan(rec({ status: status as RecommendationStatus }));
      expect(p).toMatchObject({ state: 'closed', canCreate: false });
      expect(p.message).toMatch(re);
      expect(p.fix?.href).toBe('/dashboard/suggestions');
    }
  });
});

describe('what a created piece keeps', () => {
  const h = handoff();
  const p = creationProvenance(h, NOW);

  it('the recommendation, its opportunity, reason, evidence and business context', () => {
    expect(p).toMatchObject({
      recommendationId: 'rec1',
      opportunityId: 'opp1',
      title: 'Respond to Acme’s fall bourbon promotion',
      confidence: 'HIGH',
      expectedOutcome: 'Buyers comparing options hear your position.',
      goal: 'Grow tasting-event bookings',
      channel: 'LinkedIn',
      business: {
        name: 'Botella',
        description: expect.stringMatching(/bottle shop/),
      },
      handoff: { version: 1, readiness: expect.any(String) },
    });
    expect(p.why).toMatch(/Acme discounted/);
    expect(p.why).not.toMatch(/Based on 1 piece/); // bookkeeping dropped
    expect(p.evidence).toEqual([
      { label: 'Acme cut bourbon prices', url: 'https://acme.example/pricing' },
    ]);
  });

  it('gives the writer the reason, evidence and outcome — the brief still decides angle and wording', () => {
    const text = provenancePrompt(p);
    expect(text).toMatch(/WRITTEN FOR AURA'S SUGGESTION/);
    expect(text).toMatch(
      /Evidence \(cite only this.*\): Acme cut bourbon prices/,
    );
    expect(text).toMatch(/Expected outcome: Buyers comparing/);
    expect(text).toMatch(/follow the brief/);
  });

  it('with no evidence, the writer is told to claim nothing beyond the brief', () => {
    const none = creationProvenance(handoff({ evidence: [] }), NOW);
    expect(provenancePrompt(none)).toMatch(/Evidence: none recorded/);
  });
});

describe('a content plan brief, from what the suggestion knows', () => {
  it('fills the goal, objective, topic, audience and channel — and passes the plan’s validation', () => {
    const brief = planBriefFrom(handoff());
    expect(brief).toMatchObject({
      businessGoals: 'Grow tasting-event bookings',
      campaignObjectives: 'Buyers comparing options hear your position.',
      topics: ['Curation, not price'],
      channels: ['LinkedIn'],
    });
    expect(
      planInputsSchema.safeParse({
        month: '2026-11',
        postsPerWeek: 3,
        ...brief,
      }).success,
    ).toBe(true);
  });

  it('without a stated goal, the suggestion’s own reason stands in', () => {
    const brief = planBriefFrom(handoff({}, { goals: null }));
    expect(brief.businessGoals).toMatch(
      /Respond to Acme’s fall bourbon promotion\. Acme discounted/,
    );
  });

  it('leaves out a channel the plan cannot use', () => {
    const brief = planBriefFrom(handoff({ channel: 'TikTok' }));
    expect(brief.channels).toBeUndefined();
  });
});
