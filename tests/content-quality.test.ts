import { describe, it, expect } from 'vitest';
import type { ContentDraft } from '@prisma/client';

import {
  HUMAN_WRITING_RULES,
  ROBOTIC_PHRASES,
  VARIATION_ANGLES,
  playbookFor,
} from '@/lib/content-playbook';
import {
  RESPONSIBLE_LINE,
  applySafeFixes,
  checkQuality,
  copyParts,
  isAlcoholBusiness,
  type QualityContext,
} from '@/lib/content-quality';
import {
  adSchema,
  bodySchemaFor,
  emailSchema,
  generateContentSchema,
  imagePostSchema,
  linkedInPostSchema,
  refineContentSchema,
} from '@/lib/validations/content';
import { renderForManual } from '@/server/content/render';

/**
 * Content Studio's writing rules: the platform playbook, the quality and
 * compliance check (including alcohol marketing rules), the safe automatic
 * fixes, and the new email / ad formats.
 */

const NOW = new Date('2026-10-06T12:00:00Z');
const ctx = (o: Partial<QualityContext> = {}): QualityContext => ({
  limits: playbookFor('IMAGE_POST', 'INSTAGRAM').limits,
  sources:
    'Small-batch bourbon aged 6 years in Kentucky. Tasting room open Fridays.',
  avoid: [],
  alcohol: false,
  now: NOW,
  ...o,
});
const post = (caption: string, extra: object = {}) =>
  imagePostSchema.parse({
    caption,
    cta: 'Book a tasting.',
    hashtags: ['bourbon'],
    ...extra,
  });
const codes = (r: { issues: { code: string }[] }) =>
  r.issues.map((i) => i.code);

describe('the platform playbook', () => {
  it('writes for the network: rules and limits differ by platform', () => {
    const ig = playbookFor('IMAGE_POST', 'INSTAGRAM');
    const fb = playbookFor('IMAGE_POST', 'FACEBOOK');
    const x = playbookFor('IMAGE_POST', 'X');
    expect(ig.label).toBe('Instagram image post caption');
    expect(ig.rules.join(' ')).toMatch(/first line .* before "more"/);
    expect(fb.rules.join(' ')).toMatch(/40–80 words/);
    expect(x.limits.hardMaxChars).toBe(280);
    expect(ig.limits.hashtagMax).toBeGreaterThan(fb.limits.hashtagMax);
  });

  it('email and blog are not social placements; ads follow the placement', () => {
    expect(playbookFor('EMAIL', 'LINKEDIN').label).toBe('marketing email');
    expect(playbookFor('EMAIL', null).rules.join(' ')).toMatch(/subjectLine/);
    expect(playbookFor('AD', 'INSTAGRAM').label).toBe('Instagram ad');
    expect(playbookFor('AD', 'INSTAGRAM').limits.hashtagMax).toBe(0);
  });

  it('every piece is told to write like a person, and which phrases never to use', () => {
    const rules = HUMAN_WRITING_RULES.join(' ');
    expect(rules).toMatch(/human copywriter/);
    expect(rules).toMatch(/Never claim what the material does not support/);
    for (const p of ROBOTIC_PHRASES) expect(rules).toContain(p);
    // A new draft's 1–3 versions take the first three; "More recommendations"
    // draws on the rest. Every angle is distinct.
    expect(VARIATION_ANGLES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(VARIATION_ANGLES).size).toBe(VARIATION_ANGLES.length);
  });
});

describe('alcohol brands', () => {
  it('are recognised from what the business does', () => {
    expect(isAlcoholBusiness(['SIPN', 'Small-batch Kentucky bourbon'])).toBe(
      true,
    );
    expect(isAlcoholBusiness(['A gin distillery'])).toBe(true);
    expect(isAlcoholBusiness(['We help teams begin projects'])).toBe(false);
    expect(isAlcoholBusiness(['Coffee roaster', null])).toBe(false);
  });

  it.each([
    ['alcohol-minors', 'Perfect for students heading back to school.'],
    ['alcohol-excess', 'Grab a bottle and get wasted this weekend.'],
    ['alcohol-health', 'A healthy way to unwind — it relieves stress.'],
    ['alcohol-social', 'One sip and you are the life of the party.'],
    ['alcohol-driving', 'One for the road before you head home.'],
  ])('block %s', (code, caption) => {
    const r = checkQuality(
      'IMAGE_POST',
      post(`${caption} ${RESPONSIBLE_LINE}`),
      ctx({ alcohol: true }),
    );
    expect(codes(r)).toContain(code);
    expect(r.approvable).toBe(false);
  });

  it('clean, responsible alcohol copy passes', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post(
        `Small-batch bourbon, aged 6 years. Our tasting room is open Fridays. ${RESPONSIBLE_LINE}`,
      ),
      ctx({ alcohol: true }),
    );
    expect(r.approvable).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('the same words are fine for a brand that is not alcohol', () => {
    expect(
      checkQuality(
        'IMAGE_POST',
        post('Perfect for students heading back to school.'),
        ctx(),
      ).approvable,
    ).toBe(true);
  });

  it('a responsible-drinking line is added when missing, in the right place for each format', () => {
    const c = {
      limits: playbookFor('IMAGE_POST', 'INSTAGRAM').limits,
      alcohol: true,
    };
    expect(
      (
        applySafeFixes('IMAGE_POST', post('Aged 6 years.'), c).body as {
          caption: string;
        }
      ).caption,
    ).toBe(`Aged 6 years. ${RESPONSIBLE_LINE}`);
    const email = emailSchema.parse({
      subjectLine: 'New release',
      paragraphs: ['One.', 'Two.'],
    });
    expect(
      (applySafeFixes('EMAIL', email, c).body as { paragraphs: string[] })
        .paragraphs[1],
    ).toBe(`Two. ${RESPONSIBLE_LINE}`);
    const ad = adSchema.parse({
      headline: 'New bourbon',
      primaryText: 'Aged 6 years.',
    });
    expect(
      (applySafeFixes('AD', ad, c).body as { primaryText: string }).primaryText,
    ).toMatch(/enjoy responsibly/);
    const done = applySafeFixes(
      'IMAGE_POST',
      post('Aged 6 years. Drink responsibly.'),
      c,
    );
    expect(done.fixes).not.toContain('Added a responsible-drinking line.');
    expect(
      applySafeFixes('IMAGE_POST', post('Aged 6 years.'), {
        ...c,
        alcohol: false,
      }).fixes,
    ).toEqual([]);
  });

  it('never pushes a tweet over 280 characters to add the line', () => {
    const long = 'x'.repeat(270);
    const thread = bodySchemaFor('TWEET_THREAD').parse({
      tweets: ['Hook', long],
    });
    const r = applySafeFixes('TWEET_THREAD', thread, {
      limits: playbookFor('TWEET_THREAD', 'X').limits,
      alcohol: true,
    });
    expect((r.body as { tweets: string[] }).tweets[1]).toBe(long);
  });
});

describe('claims and facts', () => {
  it('blocks claims and figures the material does not support', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post('The award-winning bourbon, now 30% off.'),
      ctx(),
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(['unsupported-claim', 'unsupported-number']),
    );
    expect(r.approvable).toBe(false);
  });

  it('allows claims and figures that are in the material', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post('Aged 6 years. Award-winning.'),
      ctx({ sources: 'Our award-winning bourbon is aged 6 years.' }),
    );
    expect(codes(r)).not.toContain('unsupported-claim');
    expect(codes(r)).not.toContain('unsupported-number');
  });

  it('blocks topics the brand never mentions', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post('Unlike cheap competitors…'),
      ctx({ avoid: ['competitors'] }),
    );
    expect(codes(r)).toContain('avoid-topic');
  });
});

describe('writing quality', () => {
  it('flags machine-written phrases', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post("In today's fast-paced world, let's dive in to a game-changer."),
      ctx(),
    );
    expect(r.issues.find((i) => i.code === 'robotic-phrase')!.severity).toBe(
      'warn',
    );
    expect(r.approvable).toBe(true);
  });

  it('flags repetitive openings and overused words', () => {
    const r = checkQuality(
      'LINKEDIN_POST',
      linkedInPostSchema.parse({
        hook: 'We love bourbon.',
        paragraphs: [
          'We love oak. We love time.',
          'We love Kentucky.',
          'Bourbon bourbon bourbon bourbon bourbon.',
        ],
        cta: 'Visit us.',
      }),
      ctx({ limits: playbookFor('LINKEDIN_POST', 'LINKEDIN').limits }),
    );
    expect(r.issues.filter((i) => i.code === 'repetition')).toHaveLength(2);
  });

  it('enforces the destination’s limits: hard (block) and ideal (warn)', () => {
    const x = playbookFor('IMAGE_POST', 'X').limits;
    expect(
      codes(
        checkQuality('IMAGE_POST', post('a '.repeat(200)), ctx({ limits: x })),
      ),
    ).toContain('too-long');
    const fb = playbookFor('IMAGE_POST', 'FACEBOOK').limits;
    expect(
      codes(
        checkQuality(
          'IMAGE_POST',
          post('word '.repeat(150)),
          ctx({ limits: fb }),
        ),
      ),
    ).toContain('long');
  });

  it('flags too many hashtags and a missing call to action', () => {
    const r = checkQuality(
      'IMAGE_POST',
      post('Aged 6 years.', { cta: '', hashtags: ['a', 'b', 'c', 'd'] }),
      ctx({ limits: playbookFor('IMAGE_POST', 'FACEBOOK').limits }),
    );
    expect(codes(r)).toEqual(expect.arrayContaining(['hashtags', 'no-cta']));
  });

  it('tidies hashtags: no #, no duplicates, within the platform limit', () => {
    const r = applySafeFixes(
      'IMAGE_POST',
      post('x', {
        hashtags: ['#Bourbon', 'bourbon', 'Kentucky', 'whiskey', 'craft'],
      }),
      { limits: playbookFor('IMAGE_POST', 'FACEBOOK').limits, alcohol: false },
    );
    expect((r.body as { hashtags: string[] }).hashtags).toEqual([
      'Bourbon',
      'Kentucky',
    ]);
    expect(r.fixes[0]).toMatch(/Trimmed hashtags to 2/);
  });
});

describe('reading every format', () => {
  it('extracts visible copy, hashtags and CTA', () => {
    const p = copyParts(
      'AD',
      adSchema.parse({
        headline: 'H',
        primaryText: 'Primary',
        cta: 'Shop now',
      }),
    );
    expect(p.text).toContain('Primary');
    expect(p.cta).toBe('Shop now');
    const t = copyParts('TWEET_THREAD', {
      tweets: ['one', 'two'],
      hashtags: ['x'],
    });
    expect(t.longestUnit).toBe(3);
    expect(t.hashtags).toEqual(['x']);
  });
});

describe('formats and inputs', () => {
  it('email and ad bodies validate, with sensible defaults', () => {
    expect(
      emailSchema.parse({ subjectLine: 'Hi', paragraphs: ['Body'] }),
    ).toMatchObject({ previewText: '', cta: '', signOff: '' });
    expect(adSchema.parse({ headline: 'H', primaryText: 'P' }).cta).toBe(
      'Learn more',
    );
    expect(
      adSchema.safeParse({ headline: 'H'.repeat(81), primaryText: 'P' })
        .success,
    ).toBe(false);
  });

  it('drafts written before the CTA field still load', () => {
    expect(
      linkedInPostSchema.parse({ hook: 'h', paragraphs: ['a', 'b', 'c'] }).cta,
    ).toBe('');
    expect(imagePostSchema.parse({ caption: 'c' }).cta).toBe('');
  });

  it('generation takes a platform, 1–3 variations and an optional tone', () => {
    expect(
      generateContentSchema.parse({
        type: 'IMAGE_POST',
        source: { kind: 'BRIEF' },
      }).variations,
    ).toBe(1);
    expect(
      generateContentSchema.safeParse({
        type: 'IMAGE_POST',
        source: { kind: 'BRIEF' },
        variations: 4,
      }).success,
    ).toBe(false);
    expect(
      generateContentSchema.safeParse({
        type: 'AD',
        source: { kind: 'BRIEF' },
        platform: 'INSTAGRAM',
        tone: 'bold',
      }).success,
    ).toBe(true);
  });

  it('refining: { feedback } alone still works; actions need what they need', () => {
    expect(refineContentSchema.parse({ feedback: 'punchier' })).toMatchObject({
      action: 'custom',
    });
    expect(refineContentSchema.safeParse({ action: 'shorten' }).success).toBe(
      true,
    );
    expect(refineContentSchema.safeParse({ action: 'tone' }).success).toBe(
      false,
    );
    expect(
      refineContentSchema.safeParse({ action: 'tone', tone: 'warm' }).success,
    ).toBe(true);
    expect(refineContentSchema.safeParse({ action: 'custom' }).success).toBe(
      false,
    );
  });

  it('email and ad copy render for pasting, and the CTA is included everywhere', () => {
    const draft = (type: string, body: unknown) =>
      ({ type, body }) as unknown as ContentDraft;
    const email = renderForManual(
      draft('EMAIL', {
        subjectLine: 'New bottling',
        previewText: 'Out Friday',
        greeting: 'Hi Sam,',
        paragraphs: ['It is here.'],
        cta: 'Reserve a bottle',
        signOff: '— The SIPN team',
      }),
    );
    expect(email).toMatch(/^Subject: New bottling\nPreview: Out Friday/);
    expect(email).toContain('[ Reserve a bottle ]');
    const ad = renderForManual(
      draft('AD', {
        headline: 'Aged 6 years',
        primaryText: 'Small batch.',
        cta: 'Shop now',
      }),
    );
    expect(ad).toBe(
      'Primary text: Small batch.\n\nHeadline: Aged 6 years\n\nButton: Shop now',
    );
    const ig = renderForManual(
      draft('IMAGE_POST', {
        caption: 'Caption.',
        cta: 'Book a tasting.',
        hashtags: ['bourbon'],
      }),
    );
    expect(ig).toBe('Caption.\n\nBook a tasting.\n\n#bourbon');
  });
});
