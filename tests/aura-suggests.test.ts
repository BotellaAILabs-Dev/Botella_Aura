import { describe, it, expect } from 'vitest';

import {
  EVIDENCE_SOURCE_LABEL,
  TECHNICAL_TOKENS,
  contextSourceLabel,
  plainBlocker,
  plainWhy,
  readableText,
  toSuggestion,
  type SuggestionRanking,
  type SuggestionSource,
} from '@/lib/aura-suggests';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';
import {
  RECOMMENDATION_TYPES,
  type RecommendationType,
} from '@/lib/recommendations';
import { SIGNAL_KINDS } from '@/lib/opportunities';

/**
 * "Aura Suggests": each recommendation must be understandable without
 * technical context, say why Aura suggested it, keep its evidence one click
 * away, and end in a clear next action.
 */

const NOW = new Date('2026-10-07T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** The ticket's own example. */
function bourbon(o: Partial<SuggestionSource> = {}): SuggestionSource {
  return {
    id: 'cm1abcdefghijklmnopqrstuv',
    opportunityId: 'cm2abcdefghijklmnopqrstuv',
    type: 'CONTENT',
    status: 'GENERATED',
    title: 'Promote your fall bourbon selection',
    summary: 'Interest in bourbon is climbing as the weather turns.',
    action:
      'Post a carousel of your fall bourbon picks on Instagram this week.',
    steps: ['Pick five bottles', 'Shoot them together', 'Post on Thursday'],
    rationale:
      'Interest in bourbon-related products has increased and your recent content has focused heavily on whiskey. Based on 2 pieces of evidence: Bourbon searches up 40%; Whiskey posts get 2x saves. A carousel post fits because it is how you get the most saves; you publish on Instagram.',
    expectedOutcome: 'Increase engagement around your fall selection.',
    channel: 'Instagram',
    contentType: 'CAROUSEL',
    audience: 'Local whiskey fans',
    details: { action: 'post' },
    confidence: 'HIGH',
    relevantUntil: days(5),
    executable: true,
    blockers: [],
    contextFields: ['objectives.goals'],
    evidence: [
      {
        id: 'e1',
        kind: 'TREND_ITEM',
        label: 'Bourbon searches up 40%',
        detail: 'Searches for "fall bourbon" rose 40% in the last two weeks.',
        url: 'https://trends.example.com/bourbon',
        observedAt: days(-3),
        current: true,
      },
      {
        id: 'e2',
        kind: 'ANALYTICS_REPORT',
        label: 'Whiskey posts get 2x saves',
        detail: 'Your last six whiskey posts were saved twice as often.',
        url: null,
        observedAt: days(-10),
        current: true,
      },
    ],
    ...o,
  };
}
const RANK: SuggestionRanking = {
  rank: 1,
  band: 'now',
  resurfaced: false,
  factors: [
    { factor: 'priority', points: 40, why: 'high priority (80/100)' },
    { factor: 'confidence', points: 8, why: 'high confidence' },
    {
      factor: 'goals',
      points: 10,
      why: 'relates to your current goal or campaign (“fall”)',
    },
    { factor: 'timing', points: 6, why: 'closes in 5 day(s)' },
  ],
};

describe('What, Why, Expected outcome, Based on, Next step', () => {
  const s = toSuggestion(bourbon(), RANK, NOW);

  it('says what to do', () => {
    expect(s.what).toBe('Promote your fall bourbon selection');
    expect(s.action).toMatch(/carousel of your fall bourbon picks/);
    expect(s.steps).toHaveLength(3);
  });

  it('says why, without the engine’s bookkeeping', () => {
    expect(s.why).toBe(
      'Interest in bourbon-related products has increased and your recent content has focused heavily on whiskey. A carousel post fits because it is how you get the most saves; you publish on Instagram.',
    );
    expect(s.why).not.toMatch(/pieces of evidence/);
  });

  it('says why now, in words — not points', () => {
    expect(s.whyNow).toEqual([
      'Relates to your current goal or campaign (“fall”)',
      'It’s only relevant for 5 more days',
    ]);
  });

  it('says the expected outcome', () => {
    expect(s.expectedOutcome).toBe(
      'Increase engagement around your fall selection.',
    );
  });

  it('says what it is based on, as in the example', () => {
    expect(s.basedOn).toEqual([
      'Trend signal',
      'Recent content performance',
      'Business goals',
    ]);
  });

  it('keeps every piece of evidence accessible, with its source and when it was seen', () => {
    expect(s.evidence).toEqual([
      expect.objectContaining({
        source: 'Trend signal',
        label: 'Bourbon searches up 40%',
        url: 'https://trends.example.com/bourbon',
        seen: '3 days ago',
        current: true,
      }),
      expect.objectContaining({
        source: 'Recent content performance',
        seen: '10 days ago',
        url: null,
      }),
    ]);
  });

  it('ends in one clear next action that also says yes, plus Edit and Skip', () => {
    expect(s.next).toEqual({
      label: 'Create content',
      href: expect.stringMatching(
        /^\/dashboard\/content\/new\?rec=cm1abcdefghijklmnopqrstuv&brief=/,
      ),
      accepts: true,
      blocked: null,
      module: 'content-studio',
      moduleLabel: 'Content Studio',
      related: [],
    });
    expect(s.editable.title).toBe(s.what);
    expect(s.stage).toBe('open');
  });

  it('carries the recommendation into Content Studio as the brief', () => {
    const brief = new URL(s.next.href, 'https://x').searchParams.get('brief')!;
    expect(brief).toMatch(/Promote your fall bourbon selection/);
    expect(brief).toMatch(/Goal: Increase engagement/);
  });

  it('says confidence, timing and place in words', () => {
    expect(s.confidence).toBe('Strong evidence');
    expect(s.timing).toBe('Best done within 5 days');
    expect(s.place).toBe('Top pick');
  });
});

describe('understandable without technical context', () => {
  const variants: SuggestionSource[] = [
    bourbon(),
    bourbon({ confidence: 'MEDIUM' }),
    bourbon({ confidence: 'LOW', blockers: [LOW_CONFIDENCE_BLOCKER] }),
    bourbon({ blockers: ['TikTok is not a channel the business uses.'] }),
    bourbon({
      type: 'CHANNEL',
      channel: 'YouTube',
      blockers: ['Aura cannot connect YouTube yet.'],
    }),
    bourbon({
      evidence: SIGNAL_KINDS.map((kind, i) => ({
        id: `e${i}`,
        kind,
        label: `Evidence ${i}`,
        detail: 'Detail',
        url: null,
        observedAt: days(-i * 20),
        current: i % 2 === 0,
      })),
      contextFields: [
        'identity.offerings',
        'audience.stated',
        'channels.preferred',
        'voice.tone',
        'something.else',
      ],
    }),
    ...RECOMMENDATION_TYPES.map((type) => bourbon({ type })),
  ];

  it('no enum names, scores, ids, codes or internal fields reach the person', () => {
    for (const v of variants) {
      for (const band of ['now', 'next', 'later', 'hidden'] as const) {
        const s = toSuggestion(v, { ...RANK, band }, NOW);
        for (const text of readableText(s)) {
          for (const re of TECHNICAL_TOKENS) {
            expect(re.test(text), `"${text}" contains ${re}`).toBe(false);
          }
        }
      }
    }
  });

  it('the check itself catches technical text (so passing means something)', () => {
    const caught = (t: string) => TECHNICAL_TOKENS.some((re) => re.test(t));
    expect(caught('Based on TREND_ITEM')).toBe(true);
    expect(caught('Surface now (score 72)')).toBe(true);
    expect(caught('confidence: HIGH')).toBe(true);
    expect(caught('written by rule:competitor-move')).toBe(true);
    expect(caught('id cm1abcdefghijklmnopqrstuv')).toBe(true);
    expect(caught('Promote your fall bourbon selection')).toBe(false);
  });

  it('every kind of evidence and every part of the profile has a plain name', () => {
    for (const k of SIGNAL_KINDS) {
      expect(EVIDENCE_SOURCE_LABEL[k]).toMatch(/^[A-Z][a-z]/);
    }
    expect(contextSourceLabel('objectives.goals')).toBe('Business goals');
    expect(contextSourceLabel('audience.stated')).toBe('Your audience');
    expect(contextSourceLabel('identity.offerings')).toBe(
      'What your business offers',
    );
    expect(contextSourceLabel('anything.else')).toBe('Your business profile');
  });

  it('the scores behind the ranking are never shown', () => {
    const s = toSuggestion(bourbon(), RANK, NOW);
    expect(s.whyNow.join(' ')).not.toMatch(/\d+\/100|priority|confidence/);
  });
});

describe('a clear next action, whatever the situation', () => {
  const LABELS: Record<RecommendationType, RegExp> = {
    CONTENT: /^Create content$/,
    COMPETITIVE_RESPONSE: /^Create content$/,
    AUDIENCE: /^Create content$/,
    CAMPAIGN: /^Plan the campaign$/,
    OPTIMIZATION: /^Add to your plan$/,
    OTHER: /^Add to your plan$/,
    CHANNEL: /^Connect Instagram$/,
  };

  it('names the action by where it goes', () => {
    for (const type of RECOMMENDATION_TYPES) {
      // No engine action recorded: routed by type.
      const s = toSuggestion(bourbon({ type, details: {} }), RANK, NOW);
      expect(s.next.label).toMatch(LABELS[type]);
      expect(s.next.href.startsWith('/dashboard/')).toBe(true);
    }
  });

  it('a low-confidence suggestion: a word of caution, and saying yes is the review', () => {
    const s = toSuggestion(
      bourbon({
        confidence: 'LOW',
        executable: false,
        blockers: [LOW_CONFIDENCE_BLOCKER],
      }),
      RANK,
      NOW,
    );
    expect(s.caution).toMatch(/less sure/);
    expect(s.confidence).toMatch(/^Early signal/);
    expect(s.next.label).toBe('Create content');
    expect(s.next.accepts).toBe(true);
    // Leads where it will lead once accepted, not to a review page.
    expect(s.next.href).toMatch(/^\/dashboard\/content\/new/);
  });

  it('something to fix first: the action leads there, and does not say yes', () => {
    const s = toSuggestion(
      bourbon({
        executable: false,
        blockers: ['TikTok is not a channel the business uses.'],
      }),
      RANK,
      NOW,
    );
    expect(s.next).toEqual({
      label: 'See what’s needed',
      href: '/dashboard/opportunities?focus=cm2abcdefghijklmnopqrstuv&rec=cm1abcdefghijklmnopqrstuv',
      accepts: false,
      blocked:
        'You don’t post on TikTok at the moment. Edit the suggestion to pick a channel you use.',
      module: 'content-studio',
      moduleLabel: 'Content Studio',
      related: [],
    });
    expect(s.caution).toBe(s.next.blocked);
  });

  it('already a yes: the next step is still there, without accepting again', () => {
    for (const status of ['ACCEPTED', 'EDITED'] as const) {
      const s = toSuggestion(bourbon({ status }), RANK, NOW);
      expect(s.stage).toBe('accepted');
      expect(s.next.accepts).toBe(false);
      expect(s.next.label).toBe('Create content');
    }
  });

  it('presented and generated suggestions are both open', () => {
    expect(
      toSuggestion(bourbon({ status: 'PRESENTED' }), RANK, NOW).next.accepts,
    ).toBe(true);
  });
});

describe('plain wording helpers', () => {
  it('plainWhy keeps the reasoning and drops the evidence count', () => {
    expect(
      plainWhy(
        'Acme cut prices. Based on 1 piece of evidence: Acme pricing page.',
      ),
    ).toBe('Acme cut prices.');
    expect(plainWhy('Just a reason.')).toBe('Just a reason.');
    // Stored text from before the wording was improved still reads well.
    expect(
      plainWhy(
        '2 different stories on "specialty coffee" Based on 2 pieces of evidence: A; B. One post fits because the business publishes on LinkedIn; relates to the business’s current goal or campaign.',
      ),
    ).toBe(
      '2 different stories on "specialty coffee". One post fits because you publish on LinkedIn; relates to your current goal or campaign.',
    );
    expect(
      plainWhy(
        '1 change(s) observed directly by Acme Coffee: pricing Based on 1 piece of evidence: X.',
      ),
    ).toBe('1 change observed directly by Acme Coffee: pricing.');
    expect(
      plainWhy('you publish on this channel and it is not connected'),
    ).toBe('You publish on this channel and it is not connected.');
  });

  it('plainBlocker says what to do, not what failed', () => {
    expect(plainBlocker('Aura cannot connect YouTube yet.')).toBe(
      'Aura can’t connect YouTube yet, so this can’t be done from here.',
    );
    expect(plainBlocker(LOW_CONFIDENCE_BLOCKER)).toMatch(
      /look over the evidence/,
    );
  });

  it('timing: no rush is not mentioned', () => {
    expect(
      toSuggestion(bourbon({ relevantUntil: null }), RANK, NOW).timing,
    ).toBeNull();
    expect(
      toSuggestion(bourbon({ relevantUntil: days(40) }), RANK, NOW).timing,
    ).toBeNull();
    expect(
      toSuggestion(bourbon({ relevantUntil: days(0.5) }), RANK, NOW).timing,
    ).toBe('Best done today');
  });

  it('evidence that is no longer current is marked, not hidden', () => {
    const s = toSuggestion(
      bourbon({
        evidence: [{ ...bourbon().evidence[0]!, current: false }],
      }),
      RANK,
      NOW,
    );
    expect(s.evidence[0]!.current).toBe(false);
  });
});
