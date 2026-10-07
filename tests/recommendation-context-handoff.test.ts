import { describe, it, expect } from 'vitest';

import {
  CONTENT_BRIEF_LIMIT,
  CONTEXT_HANDOFF_VERSION,
  HANDOFF_FIELDS,
  MISSING_FIELD_POLICY,
  buildContextHandoff,
  handoffBrief,
  handoffToContentRequest,
  relevantMemory,
  validateContextHandoff,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import { generateContentSchema } from '@/lib/validations/content';

/**
 * The Recommendation Context Handoff: everything Sprint 9 needs to turn an
 * accepted recommendation into a content brief — validated, with every gap
 * stated instead of filled in.
 */

const NOW = new Date('2026-10-07T12:00:00Z');

function input(
  r: Partial<HandoffInput['recommendation']> = {},
  b: Partial<HandoffInput['business']> = {},
): HandoffInput {
  return {
    recommendation: {
      id: 'rec1',
      opportunityId: 'opp1',
      status: 'ACCEPTED',
      type: 'COMPETITIVE_RESPONSE',
      title: 'Respond to Acme’s fall bourbon promotion',
      action: 'Publish a post on LinkedIn giving your own view on this.',
      steps: ['Lead with curation', 'Show three bottles'],
      rationale:
        'Acme discounted its fall bourbon line. Based on 1 piece of evidence: Acme cut prices.',
      expectedOutcome: 'Buyers comparing options hear your position.',
      outcomeMetric: 'engagement',
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: 'Local whiskey fans',
      details: { action: 'response-post', angle: 'Curation, not price' },
      confidence: 'HIGH',
      confidenceReason: 'Seen directly on their pricing page',
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
        tone: ['warm', 'expert'],
        phrases: ['pour yourself something good'],
        avoid: ['excessive drinking'],
        formatting: 'emoji: minimal',
      },
      memory: [
        {
          insight: 'Carousels on LinkedIn get twice the saves',
          type: 'CONTENT_FORMAT',
          confidence: 'HIGH',
          freshness: 'fresh',
        },
        {
          insight: 'Posts about bourbon tastings fill events',
          type: 'TOPIC',
          confidence: 'MEDIUM',
          freshness: 'fresh',
        },
        {
          insight: 'Tuesday mornings work best',
          type: 'TIMING',
          confidence: 'LOW',
          freshness: 'fresh',
        },
        {
          insight: 'Long captions underperform',
          type: 'CONTENT_LENGTH',
          confidence: 'HIGH',
          freshness: 'stale',
        },
      ],
      ...b,
    },
    now: NOW,
  };
}

describe('the payload carries every part of the brief', () => {
  const h = buildContextHandoff(input());

  it('is versioned and keeps the recommendation and opportunity ids', () => {
    expect(h.version).toBe(CONTEXT_HANDOFF_VERSION);
    expect(h.recommendationId).toBe('rec1');
    expect(h.opportunityId).toBe('opp1');
    expect(h.accepted).toBe(true);
  });

  it('business context, goal, audience and channel — each with where it came from', () => {
    expect(h.business).toEqual({
      name: 'Botella',
      description: 'A neighbourhood bottle shop with a curated spirits list.',
      offerings: 'Spirits, wine, tastings',
      industry: 'Retail',
      website: 'https://botella.example',
    });
    expect(h.goal).toEqual({
      value: 'Grow tasting-event bookings',
      source: 'business_profile',
    });
    expect(h.audience).toEqual({
      value: 'Local whiskey fans',
      source: 'recommendation',
    });
    expect(h.channel).toEqual({
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
      publishing: 'aura',
    });
  });

  it('the action, the reason (without bookkeeping), evidence and expected outcome', () => {
    expect(h.action).toEqual({
      title: 'Respond to Acme’s fall bourbon promotion',
      action: 'Publish a post on LinkedIn giving your own view on this.',
      steps: ['Lead with curation', 'Show three bottles'],
      angle: 'Curation, not price',
    });
    expect(h.reason).toEqual({
      why: 'Acme discounted its fall bourbon line.',
      confidence: 'HIGH',
      confidenceReason: 'Seen directly on their pricing page',
    });
    expect(h.evidence).toEqual([
      {
        label: 'Acme cut bourbon prices',
        detail: '15% off fall bourbon.',
        url: 'https://acme.example/pricing',
        observedAt: '2026-10-04T00:00:00.000Z',
      },
    ]);
    expect(h.expectedOutcome).toEqual({
      outcome: 'Buyers comparing options hear your position.',
      metric: 'engagement',
    });
  });

  it('CTA requirements: whether one is expected, how it is written, where it goes', () => {
    expect(h.cta.expected).toBe(true);
    expect(h.cta.guidance).toMatch(/single thing to do next/);
    expect(h.cta.destination).toEqual({
      value: 'https://botella.example',
      source: 'business_profile',
    });
  });

  it('the brand voice and the learned patterns that bear on this piece', () => {
    expect(h.brandVoice).toEqual({
      summary: 'Warm, knowledgeable, never snobbish.',
      tone: ['warm', 'expert'],
      phrases: ['pour yourself something good'],
      avoid: ['excessive drinking'],
      formatting: 'emoji: minimal',
    });
    expect(h.memory).toEqual([
      expect.objectContaining({
        insight: 'Carousels on LinkedIn get twice the saves',
        relevance: 'about LinkedIn, where this runs',
      }),
      expect.objectContaining({
        insight: 'Posts about bourbon tastings fill events',
        relevance: 'about this topic',
      }),
    ]);
  });

  it('with everything there: ready, nothing missing', () => {
    expect(h.readiness).toBe('ready');
    expect(h.missing).toEqual([]);
    expect(h.blockedBy).toEqual([]);
  });
});

describe('validation', () => {
  it('a built handoff validates; a malformed one is refused with where it is wrong', () => {
    const h = buildContextHandoff(input());
    expect(validateContextHandoff(h)).toEqual({ ok: true, handoff: h });
    const bad = validateContextHandoff({
      ...h,
      recommendationId: '',
      version: 2,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.startsWith('version'))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith('recommendationId'))).toBe(
        true,
      );
    }
  });

  it('every field has a missing-field policy', () => {
    for (const f of HANDOFF_FIELDS)
      expect(MISSING_FIELD_POLICY[f]).toBeDefined();
    for (const [f, p] of Object.entries(MISSING_FIELD_POLICY)) {
      if (p.level !== 'never-missing') {
        expect(p.behaviour.length, f).toBeGreaterThan(20);
      }
    }
  });
});

describe('missing information is stated, never invented', () => {
  it('no audience on the recommendation: the business’s stated audience, labelled as such', () => {
    const h = buildContextHandoff(input({ audience: null }));
    expect(h.audience).toEqual({
      value: 'Spirits enthusiasts in the city',
      source: 'business_profile',
    });
  });

  it('no audience anywhere: null, listed, and the writer is told not to invent one', () => {
    const h = buildContextHandoff(
      input({ audience: null }, { audience: null }),
    );
    expect(h.audience).toBeNull();
    expect(h.missing).toEqual([
      expect.objectContaining({
        field: 'audience',
        level: 'recommended',
        behaviour: expect.stringMatching(/without inventing a persona/),
        fix: { label: 'Describe your audience', href: '/dashboard/business' },
      }),
    ]);
    expect(h.readiness).toBe('ready_with_gaps');
  });

  it('no website: the CTA has no destination — no URL is made up', () => {
    const h = buildContextHandoff(input({}, { website: null }));
    expect(h.cta.destination).toBeNull();
    expect(h.missing.map((m) => m.field)).toEqual(['cta']);
    expect(handoffBrief(h)).toContain('CTA: name the next step, with no URL.');
  });

  it('a format that needs no CTA does not report one missing', () => {
    const h = buildContextHandoff(
      input({ contentType: 'BLOG', channel: 'Blog' }, { website: null }),
    );
    expect(h.cta.expected).toBe(false);
    expect(h.missing.map((m) => m.field)).not.toContain('cta');
  });

  it('no goal: falls back to a related campaign’s goal, labelled; else stated as missing', () => {
    const withCampaign = buildContextHandoff(
      input(
        {},
        {
          goals: null,
          campaigns: [
            {
              name: 'Fall spirits',
              goal: 'Sell out the fall bourbon line',
              audience: null,
              themes: ['bourbon'],
            },
          ],
        },
      ),
    );
    expect(withCampaign.goal).toEqual({
      value: 'Sell out the fall bourbon line',
      source: 'campaign',
    });
    const none = buildContextHandoff(input({}, { goals: null }));
    expect(none.goal).toBeNull();
    expect(none.missing.map((m) => m.field)).toEqual(['goal']);
  });

  it('no channel, voice, evidence or relevant memory: each listed with what it means', () => {
    const h = buildContextHandoff(
      input(
        { channel: null, contentType: null, evidence: [] },
        { voice: null, memory: [] },
      ),
    );
    expect(h.channel).toBeNull();
    expect(h.brandVoice).toBeNull();
    expect(h.memory).toEqual([]);
    expect(h.missing.map((m) => m.field).sort()).toEqual(
      ['brandVoice', 'channel', 'evidence', 'memory'].sort(),
    );
    expect(h.readiness).toBe('ready_with_gaps');
    // No format: nothing for Content Studio to post as-is.
    expect(handoffToContentRequest(h)).toBeNull();
  });

  it('not knowing what the business does is required: the handoff is blocked', () => {
    const h = buildContextHandoff(
      input({}, { description: null, offerings: null }),
    );
    expect(h.readiness).toBe('blocked');
    expect(h.missing[0]).toEqual(
      expect.objectContaining({ field: 'business', level: 'required' }),
    );
    expect(h.blockedBy[0]).toMatch(/would be invented/);
    expect(handoffToContentRequest(h)).toBeNull();
  });

  it('low-confidence, stale or unrelated learned patterns are not passed on', () => {
    const r = input().recommendation;
    expect(
      relevantMemory(
        [
          {
            insight: 'Tuesdays work',
            type: 'TIMING',
            confidence: 'LOW',
            freshness: 'fresh',
          },
          {
            insight: 'Short captions win',
            type: 'CONTENT_LENGTH',
            confidence: 'HIGH',
            freshness: 'stale',
          },
          {
            insight: 'Outreach on Mondays gets replies',
            type: 'OUTREACH_APPROACH',
            confidence: 'HIGH',
            freshness: 'fresh',
          },
        ],
        r,
      ),
    ).toEqual([]);
  });
});

describe('only an accepted recommendation is handed over', () => {
  it('not yet accepted: blocked, saying to accept it first', () => {
    for (const status of ['GENERATED', 'PRESENTED']) {
      const h = buildContextHandoff(input({ status }));
      expect(h.accepted).toBe(false);
      expect(h.readiness).toBe('blocked');
      expect(h.blockedBy).toEqual([
        'It has not been accepted yet. Accept or edit it first.',
      ]);
    }
  });

  it('answered another way: blocked, nothing to hand over', () => {
    const h = buildContextHandoff(input({ status: 'SKIPPED' }));
    expect(h.blockedBy).toEqual([
      'It is skipped — there is nothing to hand over.',
    ]);
  });

  it('accepted or edited: low confidence is no longer a blocker (accepting was the review)', () => {
    for (const status of ['ACCEPTED', 'EDITED']) {
      const h = buildContextHandoff(
        input({
          status,
          confidence: 'LOW',
          blockers: [LOW_CONFIDENCE_BLOCKER],
        }),
      );
      expect(h.readiness).toBe('ready');
    }
  });

  it('any other blocker (a channel the business does not use) still blocks', () => {
    const h = buildContextHandoff(
      input({ blockers: ['TikTok is not a channel the business uses.'] }),
    );
    expect(h.readiness).toBe('blocked');
    expect(h.blockedBy).toEqual(['TikTok is not a channel the business uses.']);
  });
});

describe('Content Studio', () => {
  it('the generation request is Content Studio’s own schema, carrying the recommendation id', () => {
    const req = handoffToContentRequest(buildContextHandoff(input()))!;
    expect(generateContentSchema.parse(req)).toEqual(req);
    expect(req).toEqual(
      expect.objectContaining({
        type: 'LINKEDIN_POST',
        platform: 'LINKEDIN',
        recommendationId: 'rec1',
        source: { kind: 'BRIEF', brief: expect.any(String) },
      }),
    );
  });

  it('the brief carries the recommendation, evidence, outcome, CTA and what has worked', () => {
    const brief = handoffBrief(buildContextHandoff(input()));
    expect(brief).toContain('Respond to Acme’s fall bourbon promotion');
    expect(brief).toContain('- Lead with curation');
    expect(brief).toContain('Angle: Curation, not price');
    expect(brief).toContain('For: Local whiskey fans');
    expect(brief).toContain('Why: Acme discounted its fall bourbon line.');
    expect(brief).toContain('Business goal: Grow tasting-event bookings');
    expect(brief).toContain(
      'Evidence (cite only this): Acme cut bourbon prices',
    );
    expect(brief).toContain('CTA: send people to https://botella.example.');
    expect(brief).toContain(
      'What has worked: Carousels on LinkedIn get twice the saves',
    );
    expect(brief).not.toContain('Not provided');
  });

  it('says each thing once: an angle already in the steps, and a missing CTA link', () => {
    const brief = handoffBrief(
      buildContextHandoff(
        input(
          { steps: ['Take this angle: Curation, not price'] },
          { website: null },
        ),
      ),
    );
    expect(brief).not.toMatch(/^Angle:/m);
    expect(brief).toContain('- Take this angle: Curation, not price');
    expect(brief).toContain('CTA: name the next step, with no URL.');
    expect(brief).not.toContain('Not provided');
  });

  it('says what is not provided, so the writer leaves it out', () => {
    const brief = handoffBrief(
      buildContextHandoff(
        input(
          { audience: null, evidence: [] },
          { audience: null, goals: null },
        ),
      ),
    );
    expect(brief).toContain(
      'Not provided — do not invent: evidence, goal, audience.',
    );
  });

  it('always fits Content Studio’s brief limit, keeping the essentials', () => {
    const brief = handoffBrief(
      buildContextHandoff(
        input({
          steps: Array.from({ length: 40 }, (_, i) => `Step ${i} `.repeat(12)),
        }),
      ),
    );
    expect(brief.length).toBeLessThanOrEqual(CONTENT_BRIEF_LIMIT);
    expect(brief).toContain('Respond to Acme’s fall bourbon promotion');
    expect(brief).toContain('Expected outcome:');
    expect(brief).toContain('CTA:');
  });
});
