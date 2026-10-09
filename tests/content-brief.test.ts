import { describe, it, expect } from 'vitest';

import {
  BRIEF_FIELDS,
  BRIEF_FIELD_POLICY,
  BRIEF_TEXT_LIMIT,
  briefPrompt,
  briefText,
  briefToContentRequest,
  buildContentBrief,
  contentBriefSchema,
  validateContentBrief,
  type BriefOpportunity,
  type BuildBriefInput,
} from '@/lib/content-brief';
import {
  buildContextHandoff,
  NOT_ACCEPTED_BLOCKER,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';
import { generateContentSchema } from '@/lib/validations/content';

/**
 * The Content Brief: the source of truth between the Recommendation Engine
 * and Content Studio — every field mapped, required vs optional, gaps flagged,
 * validated before generation, and passable to Content Studio as it is.
 */

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
      steps: ['Lead with curation', 'Show three bottles you would pick'],
      rationale: 'Acme discounted its fall bourbon line.',
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
          detail: '15% off fall bourbon.',
          url: 'https://acme.example/pricing',
          observedAt: new Date('2026-10-04T00:00:00Z'),
        },
      ],
      ...r,
    },
    business: {
      name: 'Botella',
      description: 'A neighbourhood bottle shop with a curated spirits list.',
      offerings: 'Spirits, wine, tastings',
      industry: 'Retail',
      website: 'https://botella.example',
      goals: 'Grow tasting-event bookings',
      audience: 'Spirits enthusiasts in the city',
      campaigns: [],
      connected: ['LinkedIn'],
      voice: {
        summary: 'Warm, knowledgeable, never snobbish.',
        tone: ['warm'],
        phrases: [],
        avoid: [],
        formatting: null,
      },
      memory: [
        {
          insight: 'Posts about bourbon tastings fill events',
          type: 'TOPIC',
          confidence: 'HIGH',
          freshness: 'fresh',
        },
      ],
      ...b,
    },
    now: NOW,
  });
}

const OPP: BriefOpportunity = {
  id: 'opp1',
  title: 'Acme discounted fall bourbon',
  type: 'COMPETITOR_MOVE',
  typeLabel: 'Competitor move',
  summary: 'Acme cut prices on its fall bourbon line by 15%.',
  angle: 'Compete on curation, not price',
};

function brief(over: Partial<BuildBriefInput> = {}) {
  return buildContentBrief(
    { handoff: handoff(), opportunity: OPP, ...over },
    NOW,
  );
}

describe('an accepted recommendation produces a structured brief', () => {
  const b = brief();

  it('has every one of the 16 fields, in order, and matches the schema', () => {
    expect(b.fields.map((f) => f.field)).toEqual([...BRIEF_FIELDS]);
    expect(BRIEF_FIELDS).toHaveLength(16);
    expect(contentBriefSchema.safeParse(b).success).toBe(true);
    expect(b.version).toBe(1);
  });

  it('every required field is populated, and it is ready for Content Studio', () => {
    for (const f of b.fields.filter((x) => x.requirement === 'required')) {
      expect(f.provided, f.field).toBe(true);
    }
    expect(b.readiness).toBe('ready');
    expect(validateContentBrief(b)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('maps the recommendation, opportunity and business context', () => {
    expect(b.recommendation).toEqual({
      id: 'rec1',
      title: 'Respond to Acme’s fall bourbon promotion',
      type: 'COMPETITIVE_RESPONSE',
      status: 'ACCEPTED',
      accepted: true,
    });
    expect(b.opportunity).toMatchObject({
      id: 'opp1',
      typeLabel: 'Competitor move',
      href: '/dashboard/opportunities?focus=opp1',
    });
    expect(b.businessContext).toMatchObject({
      name: 'Botella',
      website: 'https://botella.example',
    });
  });

  it('maps goal, audience, action, reason, evidence, outcome — each with its source', () => {
    expect(b.marketingGoal).toEqual({
      value: 'Grow tasting-event bookings',
      source: 'business_profile',
    });
    expect(b.targetAudience).toEqual({
      value: 'Local whiskey fans',
      source: 'recommendation',
    });
    expect(b.recommendedAction.steps).toHaveLength(2);
    expect(b.reason.confidence).toBe('HIGH');
    expect(b.evidence[0]).toMatchObject({
      label: 'Acme cut bourbon prices',
      url: 'https://acme.example/pricing',
    });
    expect(b.expectedOutcome.metric).toBe('engagement');
  });

  it('the key message is what Aura recorded — the recommendation’s angle first', () => {
    expect(b.keyMessage).toEqual({
      value: 'Curation, not price',
      source: 'recommendation',
    });
  });

  it('maps marketing memory and brand voice', () => {
    expect(b.relevantMemory[0]).toMatchObject({
      insight: 'Posts about bourbon tastings fill events',
    });
    expect(b.brandVoice?.summary).toMatch(/Warm/);
  });

  it('maps channel requirements: the network’s and format’s playbook, and publishing', () => {
    expect(b.channel).toMatchObject({
      name: 'LinkedIn',
      platform: 'LINKEDIN',
      publishing: 'aura',
    });
    expect(b.channel!.requirements.length).toBeGreaterThan(2);
    expect(b.contentType).toEqual({
      key: 'LINKEDIN_POST',
      label: 'LinkedIn post',
      source: 'recommendation',
    });
  });

  it('sets asset requirements from the format and network', () => {
    expect(b.assetRequirements!.copy.maxChars).toBeGreaterThan(
      b.assetRequirements!.copy.idealMaxChars,
    );
    expect(b.assetRequirements!.visual).toMatchObject({
      need: 'recommended',
      aspectRatio: '1:1',
    });
    expect(b.cta).toMatchObject({
      destination: { value: 'https://botella.example' },
    });
  });
});

describe('key message, when the recommendation has no angle', () => {
  it('falls back to the opportunity’s angle, then a concrete step — never invented', () => {
    const noAngle = handoff({ details: { action: 'response-post' } });
    expect(
      buildContentBrief({ handoff: noAngle, opportunity: OPP }).keyMessage,
    ).toEqual({
      value: 'Compete on curation, not price',
      source: 'opportunity',
    });
    expect(
      buildContentBrief({
        handoff: noAngle,
        opportunity: { ...OPP, angle: null },
      }).keyMessage,
    ).toEqual({ value: 'Lead with curation', source: 'recommendation' });
  });
});

describe('missing information is flagged explicitly', () => {
  it('a recommended gap is listed with what it means — the brief still goes ahead', () => {
    const b = buildContentBrief({
      handoff: handoff({}, { goals: null }),
      opportunity: OPP,
    });
    expect(b.marketingGoal).toBeNull();
    expect(b.missing).toContainEqual({
      field: 'marketingGoal',
      requirement: 'recommended',
      whenMissing: BRIEF_FIELD_POLICY.marketingGoal.whenMissing,
      fix: { label: 'Add your goals', href: '/dashboard/business' },
    });
    expect(b.readiness).toBe('ready_with_gaps');
    const v = validateContentBrief(b);
    expect(v.ok).toBe(true);
    expect(v.warnings).toContain(BRIEF_FIELD_POLICY.marketingGoal.whenMissing);
  });

  it('an optional gap (no learned patterns) is flagged but does not change readiness', () => {
    const b = buildContentBrief({
      handoff: handoff({}, { memory: [] }),
      opportunity: OPP,
    });
    expect(
      b.missing.find((m) => m.field === 'relevantMemory')?.requirement,
    ).toBe('optional');
    expect(b.readiness).toBe('ready');
  });

  it('no website: the CTA is flagged and never made up', () => {
    const b = buildContentBrief({
      handoff: handoff({}, { website: null }),
      opportunity: OPP,
    });
    expect(b.cta.destination).toBeNull();
    expect(b.missing.some((m) => m.field === 'cta')).toBe(true);
    expect(briefPrompt(b)).toMatch(/no URL — none is known/);
  });

  it('no business description: required — blocked, with where to add it, and nothing to post', () => {
    const b = buildContentBrief({
      handoff: handoff({}, { description: null, offerings: null }),
      opportunity: OPP,
    });
    expect(b.readiness).toBe('blocked');
    expect(
      b.missing.find((m) => m.field === 'businessContext')?.fix?.href,
    ).toMatch(/^\/dashboard\/business/);
    expect(validateContentBrief(b).ok).toBe(false);
    expect(briefToContentRequest(b)).toBeNull();
  });

  it('the opportunity is gone: required — blocked', () => {
    const b = buildContentBrief({ handoff: handoff(), opportunity: null });
    expect(b.readiness).toBe('blocked');
    expect(b.blockedBy).toContain(BRIEF_FIELD_POLICY.opportunity.whenMissing);
  });
});

describe('content type and channel', () => {
  it('no format named: required — the person picks it, and the brief follows', () => {
    const none = buildContentBrief({
      handoff: handoff({ contentType: null }),
      opportunity: OPP,
    });
    expect(none.contentType).toBeNull();
    expect(none.assetRequirements).toBeNull();
    expect(none.readiness).toBe('blocked');

    const picked = buildContentBrief({
      handoff: handoff({ contentType: null }),
      opportunity: OPP,
      choice: { type: 'CAROUSEL', platform: 'INSTAGRAM' },
    });
    expect(picked.contentType).toMatchObject({
      key: 'CAROUSEL',
      source: 'person',
    });
    expect(picked.channel?.platform).toBe('INSTAGRAM');
    expect(picked.assetRequirements!.visual).toMatchObject({
      need: 'required',
      count: { min: 3, max: 10 },
      aspectRatio: '4:5',
    });
    expect(picked.readiness).not.toBe('blocked');
  });

  it('a network the format cannot run on is not used', () => {
    const b = brief({ choice: { type: 'TWEET_THREAD', platform: 'LINKEDIN' } });
    expect(b.channel?.platform).toBe('X');
  });

  it('blog and email are not tied to a network', () => {
    const b = brief({ choice: { type: 'BLOG' } });
    expect(b.channel?.platform).toBeNull();
    expect(validateContentBrief(b).ok).toBe(true);
  });

  it('a format the workspace turned off is flagged, not used', () => {
    const b = brief({ enabledTypes: ['BLOG', 'EMAIL'] });
    expect(b.contentType).toBeNull();
    expect(
      b.missing.find((m) => m.field === 'contentType')?.whenMissing,
    ).toMatch(/turned off for this workspace/);
  });
});

describe('only an accepted recommendation goes to Content Studio', () => {
  it('still open: blocked until said yes', () => {
    const b = buildContentBrief({
      handoff: handoff({ status: 'PRESENTED' }),
      opportunity: OPP,
    });
    expect(b.blockedBy).toContain(NOT_ACCEPTED_BLOCKER);
    expect(validateContentBrief(b).ok).toBe(false);
  });

  it('skipped: nothing to write from it', () => {
    const b = buildContentBrief({
      handoff: handoff({ status: 'SKIPPED' }),
      opportunity: OPP,
    });
    expect(b.blockedBy.join(' ')).toMatch(
      /skipped — there is nothing to write from it/,
    );
  });

  it('edited and in progress go ahead', () => {
    for (const status of ['EDITED', 'IN_PROGRESS']) {
      expect(
        buildContentBrief({ handoff: handoff({ status }), opportunity: OPP })
          .readiness,
      ).not.toBe('blocked');
    }
  });
});

describe('validated before generation', () => {
  it('rejects a brief that does not match the schema', () => {
    const v = validateContentBrief({ ...brief(), version: 2 });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/^version/);
  });

  it('rejects one whose parts disagree (a format on a network it cannot run on)', () => {
    const b = brief();
    const v = validateContentBrief({
      ...b,
      channel: { ...b.channel!, platform: 'X' },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/can’t be written for X/);
  });

  it('rejects one claiming a required field it does not have', () => {
    const b = brief();
    const v = validateContentBrief({
      ...b,
      fields: b.fields.map((f) =>
        f.field === 'keyMessage' ? { ...f, provided: false } : f,
      ),
    });
    expect(v.ok).toBe(false);
  });
});

describe('passed to Content Studio without re-entry', () => {
  it('becomes Content Studio’s own request, carrying the recommendation', () => {
    const req = briefToContentRequest(brief())!;
    expect(generateContentSchema.safeParse(req).success).toBe(true);
    expect(req).toMatchObject({
      type: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
      recommendationId: 'rec1',
    });
    expect(req.source.brief).toMatch(/Respond to Acme/);
    expect(req.source.brief).toMatch(/Key message: Curation, not price/);
  });

  it('the brief text stays within Content Studio’s limit, however many steps', () => {
    const many = handoff({
      steps: Array.from(
        { length: 80 },
        (_, i) => `Step ${i}: ${'x'.repeat(60)}`,
      ),
    });
    const text = briefText(
      buildContentBrief({ handoff: many, opportunity: OPP }),
    );
    expect(text.length).toBeLessThanOrEqual(BRIEF_TEXT_LIMIT);
    expect(text).toMatch(/^Respond to Acme/);
  });

  it('the writer is held to the brief — message, evidence, length — with gaps stated', () => {
    const p = briefPrompt(
      buildContentBrief({
        handoff: handoff({}, { goals: null }),
        opportunity: OPP,
      }),
    );
    expect(p).toMatch(/Key message: Curation, not price/);
    expect(p).toMatch(/Evidence \(cite only this.*\): Acme cut bourbon prices/);
    expect(p).toMatch(/Length: up to \d+ characters/);
    expect(p).toMatch(/Not provided — do not invent: marketingGoal/);
    expect(p).toMatch(
      /Opportunity: Acme discounted fall bourbon \(Competitor move\)/,
    );
  });
});
