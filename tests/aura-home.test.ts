import { describe, it, expect } from 'vitest';

import {
  ENGAGEMENT_DROP,
  MATTERS_LIMIT,
  activeOpportunities,
  buildActivity,
  buildResults,
  closesIn,
  recommendationActivity,
  relativeTime,
  splitWeeks,
  whatMattersNow,
  type HomeCounts,
  type HomeOpportunity,
  type ResultsInput,
} from '@/lib/aura-home';
import type { SuggestionView } from '@/lib/aura-suggests';

/**
 * Aura Home: opens with actionable context (what matters now, Aura's
 * suggestions, opportunities) rather than disconnected metrics, and keeps
 * results as comparisons.
 */

const NOW = new Date('2026-10-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const NO_COUNTS: HomeCounts = {
  pendingApproval: 0,
  approvedUnscheduled: 0,
  newLeads: 0,
  outreachReady: 0,
};

function suggestion(o: Partial<SuggestionView> = {}): SuggestionView {
  return {
    id: 's1',
    status: 'GENERATED',
    stage: 'open',
    what: 'Promote your fall bourbon selection',
    action: 'Post a carousel.',
    steps: [],
    why: 'Interest is up.',
    whyNow: [],
    expectedOutcome: 'More engagement.',
    basedOn: ['Trend signal'],
    evidence: [],
    confidence: 'Strong evidence',
    timing: null,
    place: 'Top pick',
    rank: 1,
    resurfaced: false,
    channel: 'Instagram',
    caution: null,
    next: {
      label: 'Create content',
      href: '/dashboard/content/new?brief=x',
      accepts: true,
      blocked: null,
    },
    editable: {
      title: 'Promote your fall bourbon selection',
      action: 'Post a carousel.',
      steps: [],
      expectedOutcome: 'More engagement.',
      channel: 'Instagram',
    },
    ...o,
  };
}
function opportunity(o: Partial<HomeOpportunity> = {}): HomeOpportunity {
  return {
    id: 'o1',
    title: 'Join the conversation on bourbon',
    typeLabel: 'Trending topic',
    why: 'Three stories this week.',
    status: 'NEW',
    priorityScore: 60,
    daysLeft: 10,
    detectedAt: hoursAgo(5),
    ...o,
  };
}
const RESULTS: ResultsInput = {
  hasData: true,
  postsThisWeek: 3,
  postsLastWeek: 2,
  engagementThisWeek: 120,
  engagementLastWeek: 100,
  health: { score: 64, previous: 60 },
  suggestionsAnswered: 5,
  suggestionsActedOn: 3,
};

describe('What matters now', () => {
  it('nothing needs you: an empty list (Home says so, calmly)', () => {
    expect(
      whatMattersNow({
        suggestions: [suggestion()],
        accepted: [],
        opportunities: [opportunity()],
        counts: NO_COUNTS,
        results: RESULTS,
      }),
    ).toEqual([]);
  });

  it('a suggestion that is only relevant for a few days is urgent', () => {
    const m = whatMattersNow({
      suggestions: [suggestion({ timing: 'Best done within 2 days' })],
      accepted: [],
      opportunities: [],
      counts: NO_COUNTS,
      results: null,
    });
    expect(m).toEqual([
      expect.objectContaining({
        key: 'suggestion:s1',
        tone: 'urgent',
        title: 'Promote your fall bourbon selection',
        href: '/dashboard/suggestions',
      }),
    ]);
    // A week away is not "now".
    expect(
      whatMattersNow({
        suggestions: [suggestion({ timing: 'Best done within 7 days' })],
        accepted: [],
        opportunities: [],
        counts: NO_COUNTS,
        results: null,
      }),
    ).toEqual([]);
  });

  it('an opportunity about to close, with no decision yet, is urgent and links to it', () => {
    const [m] = whatMattersNow({
      suggestions: [],
      accepted: [],
      opportunities: [opportunity({ daysLeft: 2 })],
      counts: NO_COUNTS,
      results: null,
    });
    expect(m).toEqual(
      expect.objectContaining({
        tone: 'urgent',
        detail: 'This opportunity closes in 2 days.',
        href: '/dashboard/opportunities?focus=o1',
      }),
    );
  });

  it('an opportunity that already has a suggestion is not listed twice', () => {
    expect(
      whatMattersNow({
        suggestions: [],
        accepted: [],
        opportunities: [opportunity({ daysLeft: 1, status: 'RECOMMENDED' })],
        counts: NO_COUNTS,
        results: null,
      }),
    ).toEqual([]);
  });

  it(`engagement down ${ENGAGEMENT_DROP * 100}% or more on last week needs attention; a small dip does not`, () => {
    const drop = whatMattersNow({
      suggestions: [],
      accepted: [],
      opportunities: [],
      counts: NO_COUNTS,
      results: { ...RESULTS, engagementThisWeek: 60, engagementLastWeek: 100 },
    });
    expect(drop[0]).toEqual(
      expect.objectContaining({
        key: 'results:engagement-drop',
        title: 'Engagement is down 40% on last week',
        href: '/dashboard/analytics',
      }),
    );
    expect(
      whatMattersNow({
        suggestions: [],
        accepted: [],
        opportunities: [],
        counts: NO_COUNTS,
        results: {
          ...RESULTS,
          engagementThisWeek: 90,
          engagementLastWeek: 100,
        },
      }),
    ).toEqual([]);
  });

  it('work waiting on a person: approvals, accepted suggestions, scheduling, leads, outreach', () => {
    const m = whatMattersNow({
      suggestions: [],
      accepted: [suggestion({ status: 'ACCEPTED', stage: 'accepted' })],
      opportunities: [],
      counts: {
        pendingApproval: 2,
        approvedUnscheduled: 1,
        newLeads: 0,
        outreachReady: 0,
      },
      results: null,
    });
    expect(m.map((x) => x.title)).toEqual([
      '2 posts waiting for your approval',
      'Next step on “Promote your fall bourbon selection”',
      '1 approved post with no publish time',
    ]);
    expect(m[1]!.action).toBe('Create content');
    expect(m[1]!.href).toBe('/dashboard/content/new?brief=x');
  });

  it(`urgent first, and never more than ${MATTERS_LIMIT} — a priority, not a list`, () => {
    const m = whatMattersNow({
      suggestions: [],
      accepted: [],
      opportunities: [opportunity({ id: 'a', daysLeft: 1 })],
      counts: {
        pendingApproval: 1,
        approvedUnscheduled: 1,
        newLeads: 4,
        outreachReady: 2,
      },
      results: null,
    });
    expect(m).toHaveLength(MATTERS_LIMIT);
    expect(m[0]!.tone).toBe('urgent');
    expect(m.slice(1).every((x) => x.tone === 'action')).toBe(true);
  });

  it('every item has a clear action and somewhere to go', () => {
    const m = whatMattersNow({
      suggestions: [suggestion({ timing: 'Best done today' })],
      accepted: [suggestion({ id: 's2', stage: 'accepted' })],
      opportunities: [opportunity({ daysLeft: 0 })],
      counts: {
        pendingApproval: 1,
        approvedUnscheduled: 1,
        newLeads: 1,
        outreachReady: 1,
      },
      results: { ...RESULTS, engagementThisWeek: 10 },
    });
    for (const x of m) {
      expect(x.action.length).toBeGreaterThan(2);
      expect(x.href.startsWith('/dashboard')).toBe(true);
    }
  });
});

describe('Active opportunities', () => {
  it('closing within a week first, then priority, then newest', () => {
    const list = [
      opportunity({ id: 'low', priorityScore: 30, daysLeft: 20 }),
      opportunity({ id: 'high', priorityScore: 90, daysLeft: 20 }),
      opportunity({ id: 'soon', priorityScore: 10, daysLeft: 3 }),
      opportunity({ id: 'none', priorityScore: 50, daysLeft: null }),
      opportunity({ id: 'extra', priorityScore: 5, daysLeft: null }),
    ];
    expect(activeOpportunities(list).map((o) => o.id)).toEqual([
      'soon',
      'high',
      'none',
      'low',
    ]);
  });

  it('says when it closes, in words', () => {
    expect(closesIn(0)).toBe('Closes today');
    expect(closesIn(1)).toBe('Closes tomorrow');
    expect(closesIn(9)).toBe('Closes in 9 days');
    expect(closesIn(90)).toBeNull();
    expect(closesIn(null)).toBeNull();
  });
});

describe('Results — compared, not just listed', () => {
  it('each number says how it compares with last week', () => {
    const tiles = buildResults(RESULTS);
    expect(
      tiles.map((t) => [t.label, t.value, t.change?.text ?? null]),
    ).toEqual([
      ['Posts published', '3', 'Up 50% on last week'],
      ['Engagement', '120', 'Up 20% on last week'],
      ['Marketing health', '64/100', 'Up 4 points since the last check'],
      ['Suggestions acted on', '3 of 5', null],
    ]);
  });

  it('a fall says so, with the number it fell from', () => {
    const e = buildResults({
      ...RESULTS,
      engagementThisWeek: 60,
      engagementLastWeek: 100,
    })[1]!;
    expect(e.change).toEqual({
      direction: 'down',
      text: 'Down 40% on last week (100 then)',
    });
  });

  it('no data yet: honest, not a misleading zero', () => {
    const tiles = buildResults({
      ...RESULTS,
      hasData: false,
      postsThisWeek: 0,
      postsLastWeek: 0,
      engagementThisWeek: 0,
      engagementLastWeek: 0,
      health: null,
      suggestionsAnswered: 0,
      suggestionsActedOn: 0,
    });
    expect(tiles.map((t) => t.label)).toEqual([
      'Posts published',
      'Engagement',
      'Suggestions acted on',
    ]);
    expect(tiles[1]!.value).toBe('—');
    expect(tiles[1]!.note).toMatch(/once published posts have results/);
    expect(tiles.every((t) => t.change === null)).toBe(true);
  });

  it('posts published but no results recorded yet: engagement is unknown, not zero', () => {
    const e = buildResults({
      ...RESULTS,
      engagementThisWeek: 0,
      engagementLastWeek: 0,
    })[1]!;
    expect(e.value).toBe('—');
    expect(e.change).toBeNull();
  });

  it('each result links to where the detail is', () => {
    for (const t of buildResults(RESULTS)) {
      expect(t.href.startsWith('/dashboard/')).toBe(true);
    }
  });

  it('splits dated points into this week and last week', () => {
    expect(
      splitWeeks(
        [
          { date: hoursAgo(24), value: 5 },
          { date: hoursAgo(24 * 6), value: 1 },
          { date: hoursAgo(24 * 8), value: 3 },
          { date: hoursAgo(24 * 20), value: 100 },
          { date: new Date(NOW.getTime() + 3_600_000), value: 7 },
        ],
        NOW,
      ),
    ).toEqual({ thisWeek: 6, lastWeek: 3 });
  });
});

describe('Recent activity', () => {
  it('newest first, each thing once, limited', () => {
    const items = buildActivity(
      [
        { at: hoursAgo(30), by: 'aura', text: 'wrote “A”', href: null },
        { at: hoursAgo(1), by: 'Dana', text: 'said yes to “B”', href: '/x' },
        { at: hoursAgo(2), by: 'Dana', text: 'said yes to “B”', href: '/x' },
        ...Array.from({ length: 10 }, (_, i) => ({
          at: hoursAgo(100 + i),
          by: 'aura' as const,
          text: `spotted ${i}`,
          href: null,
        })),
      ],
      NOW,
    );
    expect(items).toHaveLength(8);
    expect(items[0]).toEqual(
      expect.objectContaining({
        by: 'Dana',
        byAura: false,
        text: 'said yes to “B”',
        when: '1 hour ago',
      }),
    );
    expect(items[1]).toEqual(
      expect.objectContaining({ by: 'Aura', byAura: true, when: 'yesterday' }),
    );
  });

  it('Aura’s routine bursts read as one line; a person’s actions never fold', () => {
    const burst = (n: number, group: 'suggested' | 'spotted') =>
      Array.from({ length: n }, (_, i) => ({
        at: hoursAgo(2 + i),
        by: 'aura' as const,
        text: `${group} “${i}”`,
        href: '/x',
        group,
      }));
    const items = buildActivity(
      [
        ...burst(5, 'suggested'),
        ...burst(2, 'spotted'),
        { at: hoursAgo(1), by: 'Dana', text: 'said yes to “A”', href: null },
      ],
      NOW,
    );
    expect(items.map((i) => `${i.by} ${i.text}`)).toEqual([
      'Dana said yes to “A”',
      'Aura made 5 new suggestions',
      'Aura spotted “0”',
      'Aura spotted “1”',
    ]);
    // A day apart: separate lines.
    const apart = buildActivity(
      [0, 30, 60].map((h, i) => ({
        at: hoursAgo(h),
        by: 'aura' as const,
        text: `wrote “${i}”`,
        href: null,
        group: 'wrote' as const,
      })),
      NOW,
    );
    expect(apart).toHaveLength(3);
  });

  it('says when in words', () => {
    expect(relativeTime(new Date(NOW.getTime() - 20_000), NOW)).toBe(
      'just now',
    );
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe(
      '5 minutes ago',
    );
    expect(relativeTime(hoursAgo(3), NOW)).toBe('3 hours ago');
    expect(relativeTime(hoursAgo(24 * 4), NOW)).toBe('4 days ago');
    expect(relativeTime(hoursAgo(24 * 21), NOW)).toBe('3 weeks ago');
  });

  it('a recommendation’s history reads as a sentence; noise is left out', () => {
    expect(recommendationActivity('generate', 'Post X')).toBe(
      'suggested “Post X”',
    );
    expect(recommendationActivity('accept', 'Post X')).toBe(
      'said yes to “Post X”',
    );
    expect(recommendationActivity('edit', 'Post X')).toBe(
      'edited and accepted “Post X”',
    );
    expect(recommendationActivity('skip', 'Post X')).toBe('skipped “Post X”');
    expect(recommendationActivity('present', 'Post X')).toBeNull();
  });
});
