import { describe, it, expect } from 'vitest';

import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import { OPPORTUNITY_TYPES } from '@/lib/opportunities';
import {
  ACTIONS_FOR,
  assess,
  checkSupport,
  composeRecommendation,
  engineContext,
  learnedFormatsFromSignals,
  selectActions,
  validateAiRecommendation,
  type EngineContext,
  type EngineSignal,
} from '@/lib/recommendation-engine';
import { buildHandoff, type HandoffSource } from '@/lib/recommendation-handoff';
import { recommendationContentSchema } from '@/lib/recommendations';

/**
 * The recommendation engine's rules: possible actions, selection against the
 * business, writing, assessment, validation of model output, and the support
 * gate. All deterministic — no model is called here.
 */

const NOW = new Date('2026-10-07T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function opp(o: Partial<HandoffSource> = {}): HandoffSource {
  return {
    id: 'opp1',
    type: 'TRENDING_TOPIC',
    status: 'DETECTED',
    title: 'Specialty coffee prices climb',
    summary: 'Two stories this week on rising specialty coffee prices.',
    rationale: 'Two independent stories in 14 days on a topic you follow.',
    angle: 'Explain what the harvest means for subscribers.',
    details: {},
    source: 'TRENDS',
    detectedBy: 'rule:trending-topic',
    priority: 'MEDIUM',
    priorityScore: 55,
    confidence: 'HIGH',
    confidenceReason: '2 signals, 1 high-reliability',
    impact: 'high',
    effort: 'low',
    detectedAt: days(-1),
    lastSeenAt: days(-1),
    relevantUntil: days(12),
    contextRevision: 'rev',
    contextFingerprint: 'fp',
    contextFields: [],
    signals: [
      {
        id: 'os1',
        kind: 'TREND_ITEM',
        refId: 'd:i',
        label: 'The Drum',
        detail: 'Specialty coffee prices climb 20% as harvests shrink',
        url: 'https://news.example/1',
        observedAt: days(-2),
        signalId: 'sig1',
        signal: { source: 'TRENDS', reliability: 'HIGH', expiresAt: days(12) },
      },
    ],
    ...o,
  };
}
const handoff = (
  o: Partial<HandoffSource> = {},
  extra: { shakyFields?: string[]; currentRevision?: string } = {},
) =>
  buildHandoff(opp(o), {
    now: NOW,
    shakyFields: extra.shakyFields ?? [],
    currentRevision: extra.currentRevision ?? 'rev',
  });

const CTX: EngineContext = {
  publishesOn: ['Instagram', 'LinkedIn'],
  connected: ['LinkedIn'],
  audience: 'Home brewers who buy beans online',
  assumedAudience: null,
  goals: 'Grow coffee subscriptions',
  campaignThemes: [],
  learnedFormats: [],
};
const ctx = (o: Partial<EngineContext> = {}): EngineContext => ({
  ...CTX,
  ...o,
});
const sig = (o: Partial<EngineSignal>): EngineSignal => ({
  id: 's',
  source: 'TRENDS',
  title: 't',
  summary: 's',
  reliability: 'HIGH',
  expiresAt: null,
  metadata: {},
  ...o,
});
const drop = sig({
  id: 'a1',
  source: 'ANALYTICS',
  title: 'Engagement down 40%',
  summary: 'Engagement went from 500 to 300 between the last two periods.',
  metadata: { metric: 'totalEngagement', from: 500, to: 300 },
});

describe('business context from the snapshot', () => {
  it('reads channels, confirmed audience, goals and learned formats', () => {
    const snapshot = {
      channels: { publishesOn: ['LinkedIn'], connected: [] },
      audience: { description: 'Home brewers' },
      goals: { current: 'Grow', campaigns: [{ themes: ['freshness'] }] },
      learning: {
        insights: [
          {
            type: 'CONTENT_FORMAT',
            insight: 'Carousels beat text posts',
            confidence: 'MEDIUM',
          },
          {
            type: 'CONTENT_FORMAT',
            insight: 'Threads do well',
            confidence: 'LOW',
          },
        ],
      },
      assumptions: [],
    } as unknown as BusinessContextSnapshot;
    expect(engineContext(snapshot)).toEqual({
      publishesOn: ['LinkedIn'],
      connected: [],
      audience: 'Home brewers',
      assumedAudience: null,
      goals: 'Grow',
      campaignThemes: ['freshness'],
      learnedFormats: ['CAROUSEL'],
    });
  });

  it('keeps an assumed audience apart from a confirmed one', () => {
    const snapshot = {
      audience: null,
      assumptions: [
        {
          field: 'audience.stated',
          label: 'Audience',
          value: 'Cafés',
          reason: 'inferred',
        },
      ],
    } as unknown as BusinessContextSnapshot;
    expect(engineContext(snapshot)).toMatchObject({
      audience: null,
      assumedAudience: 'Cafés',
    });
  });

  it('reads current learned formats from signals', () => {
    expect(
      learnedFormatsFromSignals([
        sig({
          source: 'MEMORY',
          title: 'Carousels beat text posts',
          metadata: { insightType: 'CONTENT_FORMAT' },
        }),
        sig({
          source: 'MEMORY',
          title: 'Threads',
          reliability: 'LOW',
          metadata: { insightType: 'CONTENT_FORMAT' },
        }),
        sig({
          source: 'MEMORY',
          title: 'Carousel on Tuesdays',
          metadata: { insightType: 'TIMING' },
        }),
      ]),
    ).toEqual(['CAROUSEL']);
  });
});

describe('possible actions', () => {
  it('every opportunity type has at least one action', () => {
    for (const t of OPPORTUNITY_TYPES)
      expect(ACTIONS_FOR[t].length).toBeGreaterThan(0);
  });
});

describe('selecting the action that fits the business', () => {
  it('a high-impact trend with time left: series and post both viable, ranked with reasons', () => {
    const s = selectActions(handoff(), ctx(), [], NOW);
    expect(s.viable.map((a) => a.spec.id).sort()).toEqual(['post', 'series']);
    expect(s.viable[0]!.channel).toBe('LinkedIn'); // connected first
    expect(s.viable[0]!.reasons.join(' ')).toMatch(/LinkedIn is connected/);
    expect(s.viable[0]!.reasons.join(' ')).toMatch(/current goal/); // "coffee"
  });

  it('closing within a week: no series, and quick actions first', () => {
    const s = selectActions(
      handoff({ relevantUntil: days(4) }),
      ctx(),
      [],
      NOW,
    );
    expect(s.viable.map((a) => a.spec.id)).toEqual(['post']);
    expect(s.unsupported[0]).toMatchObject({ id: 'series' });
    expect(s.unsupported[0]!.reasons[0]).toMatch(/4 day\(s\) left/);
  });

  it('a low-impact opening is not worth a series', () => {
    const s = selectActions(handoff({ impact: 'low' }), ctx(), [], NOW);
    expect(s.unsupported.find((u) => u.id === 'series')!.reasons[0]).toMatch(
      /low impact/,
    );
  });

  it('nowhere to publish: content actions are unsupported', () => {
    const s = selectActions(
      handoff(),
      ctx({ publishesOn: [], connected: [] }),
      [],
      NOW,
    );
    expect(s.viable).toEqual([]);
    expect(
      s.unsupported.every((u) =>
        /has not said where it publishes/.test(u.reasons[0]!),
      ),
    ).toBe(true);
  });

  it('an article needs a blog or newsletter the business actually uses', () => {
    const gap = handoff({ type: 'CONTENT_GAP' });
    const without = selectActions(gap, ctx(), [], NOW);
    expect(
      without.unsupported.find((u) => u.id === 'article')!.reasons[0],
    ).toMatch(/Blog or Newsletter/);
    const withBlog = selectActions(
      gap,
      ctx({ publishesOn: ['Blog', 'LinkedIn'] }),
      [],
      NOW,
    );
    expect(withBlog.viable.find((a) => a.spec.id === 'article')!.channel).toBe(
      'Blog',
    );
  });

  it('uses a format the business learned works, on a channel that carries it', () => {
    const s = selectActions(
      handoff(),
      ctx({ learnedFormats: ['CAROUSEL'] }),
      [],
      NOW,
    );
    expect(s.viable[0]!.contentType).toBe('CAROUSEL');
    const r = composeRecommendation(handoff(), s.viable[0]!, ctx(), []);
    expect(r.action).toMatch(
      /^Publish (a carousel|three carousels) on LinkedIn/,
    );
    expect(s.viable[0]!.reasons.join(' ')).toContain(
      'a format that works for you (carousel)',
    );
  });

  it('connecting a channel: only one the business uses and has not connected', () => {
    const ch = (channel: string) =>
      handoff({ type: 'CHANNEL', details: { channel } });
    expect(
      selectActions(ch('Instagram'), ctx(), [], NOW).viable[0]!.spec.id,
    ).toBe('connect-channel');
    expect(
      selectActions(ch('LinkedIn'), ctx(), [], NOW).unsupported[0]!.reasons[0],
    ).toMatch(/already connected/);
    expect(
      selectActions(ch('YouTube'), ctx(), [], NOW).unsupported[0]!.reasons[0],
    ).toMatch(/does not publish on YouTube/);
  });

  it('a targeted post needs a known audience; an assumed one is flagged', () => {
    const seg = handoff({ type: 'AUDIENCE_SEGMENT' });
    expect(
      selectActions(seg, ctx({ audience: null }), [], NOW).unsupported.find(
        (u) => u.id === 'targeted-post',
      )!.reasons[0],
    ).toMatch(/no audience is known/);
    const assumed = selectActions(
      seg,
      ctx({ audience: null, assumedAudience: 'Cafés' }),
      [],
      NOW,
    );
    expect(
      assumed.viable.find((a) => a.spec.id === 'targeted-post')!.flags[0],
    ).toMatch(/assumed/);
  });

  it('a recovery post needs an actual drop in results among the evidence', () => {
    const pattern = handoff({ type: 'PERFORMANCE_PATTERN' });
    expect(
      selectActions(pattern, ctx(), [], NOW).unsupported.map((u) => u.id),
    ).toEqual(['recovery-post', 'apply-pattern']);
    expect(selectActions(pattern, ctx(), [drop], NOW).viable[0]!.spec.id).toBe(
      'recovery-post',
    );
  });
});

describe('writing the recommendation', () => {
  it('has a clear action, says why, and what to expect', () => {
    const h = handoff();
    const chosen = selectActions(h, ctx(), [], NOW).viable.find(
      (a) => a.spec.id === 'post',
    )!;
    const r = composeRecommendation(h, chosen, ctx(), []);
    expect(recommendationContentSchema.safeParse(r).success).toBe(true);
    expect(r.action).toBe('Publish a post on LinkedIn about this, this week.');
    expect(r.rationale).toContain('Two independent stories');
    expect(r.rationale).toContain('Based on 1 piece of evidence: The Drum');
    expect(r.rationale).toMatch(/fits because .*LinkedIn is connected/);
    expect(r.expectedOutcome.length).toBeGreaterThan(10);
    expect(r).toMatchObject({
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: CTX.audience,
    });
    expect(r.details).toMatchObject({ action: 'post' });
  });

  it('an outcome for a drop names the metric and its numbers from the evidence', () => {
    const h = handoff({ type: 'PERFORMANCE_PATTERN' });
    const chosen = selectActions(h, ctx(), [drop], NOW).viable[0]!;
    const r = composeRecommendation(h, chosen, ctx(), [drop]);
    expect(r.expectedOutcome).toBe(
      'Engagement recovers toward 500 (it went from 500 to 300).',
    );
    expect(r.outcomeMetric).toBe('Engagement');
  });

  it('connecting a channel has no audience and no format', () => {
    const h = handoff({ type: 'CHANNEL', details: { channel: 'Instagram' } });
    const chosen = selectActions(h, ctx(), [], NOW).viable[0]!;
    const r = composeRecommendation(h, chosen, ctx(), []);
    expect(r).toMatchObject({
      type: 'CHANNEL',
      channel: 'Instagram',
      contentType: null,
      audience: null,
    });
    expect(r.action).toBe('Connect Instagram to Aura.');
  });
});

describe('validating model output', () => {
  const h = handoff();
  const chosen = selectActions(h, ctx(), [], NOW).viable.find(
    (a) => a.spec.id === 'post',
  )!;
  const template = composeRecommendation(h, chosen, ctx(), []);
  const snapshot = {
    trust: { 'identity.description': {} },
    assumptions: [],
  } as unknown as BusinessContextSnapshot;
  const good = {
    title: 'Explain the price rise to your subscribers',
    summary: 'Prices are rising across specialty coffee.',
    action:
      'Publish a LinkedIn post explaining why prices are rising this week.',
    steps: [
      'Open with the harvest news',
      'Explain what it means for subscribers',
    ],
    rationale:
      'Prices climbed 20% as harvests shrink, and your buyers will notice.',
    expectedOutcome: 'Subscribers understand the change and stay.',
    outcomeMetric: 'engagement',
    evidence: ['E1'],
    businessFacts: ['identity.description'],
    assumptions: [],
  };
  const run = (raw: unknown) =>
    validateAiRecommendation(raw, {
      h,
      snapshot,
      snapshotText: 'BUSINESS CONTEXT',
      template,
      now: NOW,
    });

  it('accepts supported output, keeping the engine’s choices', () => {
    const r = run(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.action).toBe(good.action);
      expect(r.content).toMatchObject({
        type: 'CONTENT',
        channel: 'LinkedIn',
        contentType: 'LINKEDIN_POST',
      });
    }
  });

  it.each([
    [
      'an invented figure',
      { ...good, expectedOutcome: 'Engagement up 35%.' },
      /35%/,
    ],
    ['evidence it was not given', { ...good, evidence: ['E7'] }, /E7/],
    [
      'an unknown business fact',
      { ...good, businessFacts: ['products.prices'] },
      /products\.prices/,
    ],
    [
      'a declared assumption',
      { ...good, assumptions: ['They sell gift boxes'] },
      /assumptions/,
    ],
    ['no evidence at all', { ...good, evidence: [] }, /evidence/],
    ['malformed output', { title: 'x' }, /summary|action/],
  ])('rejects %s', (_label, raw, reason) => {
    const r = run(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(reason);
  });
});

describe('assessment', () => {
  it('priority reflects the action’s effort; confidence carries over with its reason', () => {
    const h = handoff();
    const s = selectActions(h, ctx(), [], NOW);
    const post = assess(
      h,
      s.viable.find((a) => a.spec.id === 'post')!,
      [],
      NOW,
    );
    const series = assess(
      h,
      s.viable.find((a) => a.spec.id === 'series')!,
      [],
      NOW,
    );
    expect(post.confidence).toBe('HIGH');
    expect(post.priorityScore).toBeGreaterThan(series.priorityScore);
    expect(post.priorityReason).toMatch(
      /high impact, low effort \(one post\), high confidence, 12 day\(s\) left/,
    );
  });

  it('anything unconfirmed caps confidence at medium', () => {
    const h = handoff();
    const a = assess(
      h,
      selectActions(h, ctx(), [], NOW).viable[0]!,
      ['aims at an assumed audience'],
      NOW,
    );
    expect(a.confidence).toBe('MEDIUM');
    expect(a.confidenceReason).toMatch(
      /capped at medium: aims at an assumed audience/,
    );
  });

  it('a low-confidence opportunity never yields a high-priority recommendation', () => {
    const h = handoff({ confidence: 'LOW' });
    const a = assess(h, selectActions(h, ctx(), [], NOW).viable[0]!, [], NOW);
    expect(['LOW', 'MEDIUM']).toContain(a.priority);
  });
});

describe('the support gate', () => {
  const h = handoff();
  const chosen = selectActions(h, ctx(), [], NOW).viable.find(
    (a) => a.spec.id === 'post',
  )!;
  const r = composeRecommendation(h, chosen, ctx(), []);
  const gate = (content = r, hh = h, flags: string[] = []) =>
    checkSupport(content, { h: hh, ctx: ctx(), chosenFlags: flags, now: NOW });

  it('passes a template recommendation clean', () => {
    expect(gate()).toEqual({ rejected: [], flags: [] });
  });

  it('rejects content with nowhere to publish, and recommendations on stale evidence', () => {
    expect(gate({ ...r, channel: null }).rejected[0]).toMatch(
      /nowhere to publish/,
    );
    const stale = handoff({
      signals: [
        {
          ...opp().signals[0]!,
          signal: {
            source: 'TRENDS',
            reliability: 'HIGH',
            expiresAt: days(-1),
          },
        },
      ],
    });
    expect(gate(r, stale).rejected[0]).toMatch(
      /none of its evidence is current/,
    );
  });

  it('flags a channel the business does not use, invented figures, and shaky or changed context', () => {
    expect(gate({ ...r, channel: 'YouTube' }).flags[0]).toMatch(
      /YouTube is not a channel/,
    );
    expect(
      gate({ ...r, expectedOutcome: 'Engagement up 35%.' }).flags[0],
    ).toMatch(/35%/);
    expect(
      gate(r, handoff({}, { shakyFields: ['audience.stated'] })).flags[0],
    ).toMatch(/unconfirmed/);
    expect(gate(r, handoff({}, { currentRevision: 'rev-2' })).flags[0]).toMatch(
      /changed since/,
    );
  });
});
