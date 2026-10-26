import { describe, it, expect } from 'vitest';

import {
  addVersion,
  availableVariations,
  extractFacts,
  findIntroducedFacts,
  HEADLINE_FIELD,
  MAX_VERSIONS,
  preserveInstructions,
  variationInstruction,
  withField,
  type DraftVersion,
  droppedTopicTerms,
  topicOverlap,
  topicTerms,
  TOPIC_DRIFT_FLOOR,
} from '@/lib/content-variations';
import { CONTENT_TYPES } from '@/lib/validations/content';
import { SAMPLE_BODIES } from './fixtures/format-bodies';

/**
 * Variations: made on request, kept next to the original, and never allowed
 * to change the facts to look different.
 */

const option = (
  type: Parameters<typeof availableVariations>[0],
  kind: string,
  platform: Parameters<typeof availableVariations>[1] = 'LINKEDIN',
) => availableVariations(type, platform).find((o) => o.kind === kind)!;

describe('what can be asked for', () => {
  it('every format offers shorter, longer and another tone', () => {
    for (const type of CONTENT_TYPES) {
      for (const kind of ['shorter', 'longer', 'tone'])
        expect(option(type, kind).available, `${type} ${kind}`).toBe(true);
    }
    expect(option('LINKEDIN_POST', 'tone').tones?.length).toBeGreaterThan(3);
  });

  it('an alternative headline only where the format has one; a thread has no separate CTA', () => {
    for (const type of CONTENT_TYPES) {
      expect(option(type, 'headline').available, type).toBe(
        HEADLINE_FIELD[type] !== null,
      );
    }
    expect(option('TWEET_THREAD', 'cta')).toMatchObject({ available: false });
    expect(option('TWEET_THREAD', 'cta').reason).toMatch(
      /inside the last post/,
    );
  });

  it('another channel: only networks the format runs on, never the current one', () => {
    expect(option('IMAGE_POST', 'channel', 'INSTAGRAM').platforms).toEqual([
      'FACEBOOK',
      'LINKEDIN',
      'X',
    ]);
    expect(option('LINKEDIN_POST', 'channel', 'LINKEDIN').platforms).toEqual([
      'FACEBOOK',
    ]);
    expect(option('TWEET_THREAD', 'channel', 'X').available).toBe(false);
    expect(option('EMAIL', 'channel', null).available).toBe(false);
  });

  it('another image wherever the format takes one', () => {
    expect(option('IMAGE_POST', 'image').available).toBe(true);
    expect(option('CAMPAIGN_COPY', 'image', null).available).toBe(false);
  });
});

describe('the guardrail, as the writer reads it', () => {
  const p = preserveInstructions({
    goal: 'Grow subscriptions',
    audience: 'Home brewers',
    keyMessage: 'Honest about prices',
    evidence: ['Coffee prices climb as harvests shrink'],
    ctaDestination: 'https://roastery.example',
    avoid: ['caffeine health claims'],
    voice: 'Warm and plain',
    facts: ['15%', '$18.50'],
  });

  it('keeps goal, audience, key message, evidence, CTA destination and brand', () => {
    expect(p).toMatch(/Goal: Grow subscriptions/);
    expect(p).toMatch(/Audience: Home brewers/);
    expect(p).toMatch(
      /Evidence \(the only claims allowed\): Coffee prices climb/,
    );
    expect(p).toMatch(/sends people: https:\/\/roastery\.example/);
    expect(p).toMatch(/Never mention: caffeine health claims/);
    expect(p).toMatch(/Brand voice: Warm and plain/);
  });

  it('names the facts that must not change, and forbids changing facts to differ', () => {
    expect(p).toMatch(
      /These facts, unchanged wherever they appear: 15% · \$18\.50/,
    );
    expect(p).toMatch(/Do NOT change, round or invent any number, price/);
  });

  it('each kind says what to vary — and longer adds no new facts', () => {
    expect(variationInstruction('longer')).toMatch(
      /Add no new numbers, prices, dates or claims/,
    );
    expect(variationInstruction('channel', { platform: 'FACEBOOK' })).toMatch(
      /Rewrite it for Facebook/,
    );
    expect(variationInstruction('cta', { field: 'cta' })).toMatch(
      /ONE alternative for the `cta` field/,
    );
    expect(variationInstruction('headline', { field: 'subjectLine' })).toMatch(
      /`subjectLine`/,
    );
  });
});

describe('facts', () => {
  it('finds numbers, prices, percentages, dates, links, emails and handles', () => {
    const f = extractFacts(
      'Beans are $18.50, up 15% since 3 March 2026. Read https://www.roastery.example/prices/ or email hello@roastery.example, @roastery. Founded 2014. 3 tips.',
    );
    expect(f).toEqual(
      expect.arrayContaining([
        '$18.50',
        '15%',
        '3 march 2026',
        'roastery.example/prices',
        'hello@roastery.example',
        '@roastery',
        '2014',
      ]),
    );
    expect(f).not.toContain('3'); // "3 tips" is wording, not a fact
  });

  it('a changed price or percentage is caught; a dropped one is not a change', () => {
    const original = 'Bags are $18.50 and prices rose 15%.';
    expect(
      findIntroducedFacts(original, 'Bags are $19.50 and prices rose 15%.'),
    ).toEqual(['$19.50']);
    expect(findIntroducedFacts(original, 'Prices rose 20%.')).toEqual(['20%']);
    expect(findIntroducedFacts(original, 'Bags are $18.50.')).toEqual([]);
  });

  it('a fact from the brief or evidence is allowed; a link differing only in form is the same link', () => {
    expect(
      findIntroducedFacts('Prices rose.', 'Prices rose 15%.', [
        'Coffee prices up 15% this year',
      ]),
    ).toEqual([]);
    expect(
      findIntroducedFacts(
        'See https://roastery.example',
        'See https://www.roastery.example/',
      ),
    ).toEqual([]);
  });
});

describe('versions', () => {
  const v = (angle: string): DraftVersion => ({ angle, body: {} });

  it('keeps at most 8, never drops the one in use, and follows it', () => {
    let list = [v('Original')];
    let active = 0;
    for (let i = 1; i <= 10; i++) {
      const r = addVersion(list, active, v(`V${i}`));
      list = r.versions;
      active = r.active;
      expect(r.index).toBe(list.length - 1);
    }
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(list[active]!.angle).toBe('Original');
  });

  it('an alternative CTA or headline changes that one field and nothing else', () => {
    const body = SAMPLE_BODIES.LINKEDIN_POST;
    const next = withField(body, 'cta', '  Book a tasting this week.  ');
    expect(next.cta).toBe('Book a tasting this week.');
    expect({ ...next, cta: body.cta }).toEqual(body);
    expect(
      (withField(body, 'hook', 'x'.repeat(500)).hook as string).length,
    ).toBe(300);
  });
});

/**
 * Topic drift.
 *
 * A variation is allowed to change every word; it is not allowed to change
 * the SUBJECT. The fact check (findIntroducedFacts, above) catches a version
 * that invents a number — this catches the other half: a version that invents
 * nothing, reads well, and is simply about something else.
 */
describe('topic drift', () => {
  const original =
    'Our distillery switched to locally malted barley this spring. ' +
    'The maltings are forty miles away, which cut our grain haulage by half ' +
    'and gave the spirit a rounder, biscuity character.';

  it('ignores grammar and marketing filler when deciding the subject', () => {
    const terms = topicTerms(original);
    expect(terms.has('distillery')).toBe(true);
    expect(terms.has('barley')).toBe(true);
    expect(terms.has('malting')).toBe(true);
    // Words every brand post contains say nothing about what this one is about.
    for (const filler of ['with', 'which', 'their', 'business', 'customer', 'growth']) {
      expect(terms.has(filler)).toBe(false);
    }
  });

  it('counts a singular and a plural as the same subject', () => {
    expect(topicTerms('distilleries').has('distillery')).toBe(true);
    expect(topicTerms('maltings').has('malting')).toBe(true);
  });

  it('a genuinely different hook on the same subject stays on topic', () => {
    const sameSubject =
      'Forty miles. That is how far our barley now travels to be malted — ' +
      'down from the other end of the country. Half the haulage, and a ' +
      'rounder, biscuity spirit out of the distillery for it.';
    expect(topicOverlap(original, sameSubject)).toBeGreaterThan(
      TOPIC_DRIFT_FLOOR,
    );
  });

  it('a post about something else entirely has drifted', () => {
    const different =
      'Hospitality is changing. Guests want provenance, they want a story, ' +
      'and they want to feel welcome the moment they walk in. Here is how we ' +
      'train our front-of-house team to deliver that.';
    expect(topicOverlap(original, different)).toBeLessThan(TOPIC_DRIFT_FLOOR);
  });

  it('names what the variation dropped, so the message can say', () => {
    const dropped = droppedTopicTerms(original, 'A short note about hospitality.');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped).toContain('distillery');
  });

  it('a shorter version of the same post is not drift', () => {
    // Shortening is a legitimate variation and must never be flagged.
    expect(
      topicOverlap(original, 'Our distillery now uses locally malted barley.'),
    ).toBeGreaterThan(TOPIC_DRIFT_FLOOR);
  });

  it('treats an empty original as on topic rather than dividing by zero', () => {
    expect(topicOverlap('', 'anything at all')).toBe(1);
    expect(topicOverlap('the and of', 'anything at all')).toBe(1);
    expect(topicOverlap('anything at all', '')).toBe(1);
  });

  it('a longer version that adds material on the same subject is not drift', () => {
    // The mirror of shortening: "expand" adds words of its own, and must not
    // be read as a change of subject either.
    const expanded =
      original +
      ' The maltings floor-malt in small batches, so each delivery is ' +
      'traceable to a single field, and our stillman can taste the difference ' +
      'between one farm and the next.';
    expect(topicOverlap(original, expanded)).toBeGreaterThan(TOPIC_DRIFT_FLOOR);
  });
});
