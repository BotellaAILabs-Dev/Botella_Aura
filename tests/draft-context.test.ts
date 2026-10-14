import { describe, it, expect } from 'vitest';

import { buildContentBrief, type BriefOpportunity } from '@/lib/content-brief';
import { draftContext, draftContextPrompt } from '@/lib/draft-context';
import { buildContextHandoff } from '@/lib/recommendation-context-handoff';
import { creationProvenance } from '@/lib/recommendation-creation';
import { visualBriefStarterPrompt } from '@/lib/visual-brief';

/**
 * The recommendation context a draft keeps after it is written, as read by
 * the later Content Studio steps (regenerate, creatives, images, the board) —
 * and the guarantee that a draft written by hand reads exactly as before.
 */

const OPP: BriefOpportunity = {
  id: 'opp1',
  title: 'Coffee prices are rising',
  type: 'TRENDING_TOPIC',
  typeLabel: 'Trending topic',
  summary: '',
  angle: null,
};

const handoff = buildContextHandoff({
  recommendation: {
    id: 'rec1',
    opportunityId: 'opp1',
    status: 'ACCEPTED',
    type: 'CONTENT',
    title: 'Explain the coffee price rise',
    action: 'Tell subscribers why prices rose.',
    steps: [],
    rationale: 'Prices are rising.',
    expectedOutcome: 'Subscribers understand.',
    outcomeMetric: null,
    channel: 'Instagram',
    contentType: 'IMAGE_POST',
    audience: null,
    details: { angle: 'Honest about where the money goes' },
    confidence: 'HIGH',
    confidenceReason: null,
    executable: true,
    blockers: [],
    evidence: [
      {
        label: 'Arabica futures up 40% this year',
        detail: 'ICE coffee futures',
        url: 'https://news.example/coffee',
        observedAt: null,
      },
    ],
  },
  business: {
    name: 'Roastery',
    description: 'Small-batch roaster.',
    offerings: 'Single-origin coffee subscriptions',
    industry: 'Coffee',
    website: 'https://roastery.example',
    goals: 'Grow subscriptions',
    audience: 'Home brewers',
    campaigns: [],
    connected: ['Instagram'],
    voice: null,
    memory: [],
  },
});

const brief = buildContentBrief({
  handoff,
  opportunity: OPP,
  choice: { type: 'IMAGE_POST', platform: 'INSTAGRAM' },
  brand: { colors: ['#6B3E26'], hasLogo: false },
  marketMode: 'B2C',
});

/** As server/content/generator.ts stores it, through a JSON round trip. */
const stored = JSON.parse(
  JSON.stringify({
    source: { kind: 'BRIEF', brief: 'Explain the coffee price rise' },
    recommendation: {
      ...creationProvenance(handoff),
      id: 'rec1',
      title: 'Explain the coffee price rise',
    },
    brief,
  }),
);

describe('draftContext', () => {
  it('reads what a recommendation draft carries', () => {
    const c = draftContext(stored);
    expect(c.fromRecommendation).toBe(true);
    expect(c.recommendationId).toBe('rec1');
    expect(c.title).toBe('Explain the coffee price rise');
    expect(c.keyMessage).toBe(brief.keyMessage?.value);
    expect(c.audience).toBe('Home brewers');
    expect(c.goal).toBe('Grow subscriptions');
    expect(c.expectedOutcome).toBe('Subscribers understand.');
    expect(c.evidence).toEqual(['Arabica futures up 40% this year']);
  });

  it('a manual draft carries nothing, and adds nothing to a prompt', () => {
    for (const meta of [
      null,
      undefined,
      {},
      { source: { kind: 'BRIEF', brief: 'Our new blend' } },
      'not an object',
    ]) {
      const c = draftContext(meta);
      expect(c.fromRecommendation).toBe(false);
      expect(c.keyMessage).toBeNull();
      expect(c.evidence).toEqual([]);
      expect(draftContextPrompt(c)).toBe('');
    }
  });

  it('an older draft with only id and title still counts, with gaps empty', () => {
    const c = draftContext({ recommendation: { id: 'rec0', title: 'Old one' } });
    expect(c.fromRecommendation).toBe(true);
    expect(c.title).toBe('Old one');
    expect(c.keyMessage).toBeNull();
    const p = draftContextPrompt(c);
    expect(p).toContain('"Old one"');
    // No evidence on record: the writer is told not to make claims.
    expect(p).toContain('make no claims');
  });

  it('falls back to the provenance when the brief is absent', () => {
    const c = draftContext({ recommendation: stored.recommendation });
    expect(c.goal).toBe('Grow subscriptions');
    expect(c.evidence).toEqual(['Arabica futures up 40% this year']);
  });

  it('the rewrite prompt holds the piece to the key message and evidence', () => {
    const p = draftContextPrompt(draftContext(stored));
    expect(p).toContain(`Key message: ${brief.keyMessage?.value}`);
    expect(p).toContain('cite only this');
    expect(p).toContain('Arabica futures up 40% this year');
  });
});

describe('visualBriefStarterPrompt', () => {
  it('is a short, readable prompt from the visual brief', () => {
    const v = brief.visual!;
    const p = visualBriefStarterPrompt(v);
    expect(p.length).toBeGreaterThan(20);
    expect(p.length).toBeLessThanOrEqual(2000);
    expect(p).toContain(v.format.aspectRatio);
    expect(p).not.toContain('..');
  });
});
