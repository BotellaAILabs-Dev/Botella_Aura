import { describe, it, expect } from 'vitest';

import {
  applyFields,
  bodyToFields,
  changedEdits,
  editsStorageKey,
  REVIEW_ACTIONS,
  reviewHref,
} from '@/lib/review-item';
import { bodySchemaFor } from '@/lib/validations/content';

/**
 * The unified review: every format's generated content edited the same way,
 * field by field, and written back without disturbing anything else.
 */

const LINKEDIN = {
  hook: 'Not the cheapest rye. The one we drink.',
  paragraphs: [
    'Picked by people who taste everything.',
    'Friday we pour three.',
    'Come early.',
  ],
  cta: 'Save your seat.',
  hashtags: ['rye', 'tasting'],
};
const CAROUSEL = {
  title: 'Five ryes to know',
  slides: [
    { headline: 'One', body: 'Spicy' },
    { headline: 'Two', body: 'Soft' },
    { headline: 'Three', body: 'Bold' },
    { headline: 'Four', body: 'Dry' },
    { headline: 'Five', body: 'Sweet' },
  ],
  cta: 'Taste them Friday.',
  hashtags: [],
};

describe('any format becomes labelled fields', () => {
  it('a LinkedIn post: hook, numbered paragraphs, CTA, hashtags as one list', () => {
    const f = bodyToFields(LINKEDIN);
    expect(f.map((x) => x.label)).toEqual([
      'Hook',
      'Paragraph 1',
      'Paragraph 2',
      'Paragraph 3',
      'Call to action',
      'Hashtags',
    ]);
    expect(f.find((x) => x.key === 'hashtags')).toMatchObject({
      value: 'rye tasting',
      list: true,
    });
    expect(f.find((x) => x.key === 'paragraphs.0')?.multiline).toBe(true);
  });

  it('a carousel: each slide’s headline and body', () => {
    const f = bodyToFields(CAROUSEL);
    expect(f.map((x) => x.key)).toContain('slides.2.headline');
    expect(f.find((x) => x.key === 'slides.2.body')?.label).toBe(
      'Slide 3 · body',
    );
  });

  it('an email: subject, preview, greeting, paragraphs, CTA, sign-off', () => {
    const f = bodyToFields({
      subjectLine: 'Friday pours',
      previewText: 'Three ryes',
      greeting: 'Hi there,',
      paragraphs: ['A', 'B'],
      cta: 'Book',
      signOff: 'Oak & Barrel',
    });
    expect(f.map((x) => x.label)).toEqual([
      'Subject line',
      'Preview text',
      'Greeting',
      'Paragraph 1',
      'Paragraph 2',
      'Call to action',
      'Sign-off',
    ]);
  });
});

describe('edits are written back, and only edits', () => {
  it('changes one paragraph and the hashtags; everything else is as it was', () => {
    const fields = bodyToFields(LINKEDIN);
    const next = applyFields(
      LINKEDIN,
      {
        'paragraphs.1': 'Friday we pour four.',
        hashtags: '#rye, bourbon  #friday',
      },
      fields,
    ) as typeof LINKEDIN;
    expect(next.paragraphs).toEqual([
      'Picked by people who taste everything.',
      'Friday we pour four.',
      'Come early.',
    ]);
    expect(next.hashtags).toEqual(['rye', 'bourbon', 'friday']);
    expect(next.hook).toBe(LINKEDIN.hook);
    expect(LINKEDIN.paragraphs[1]).toBe('Friday we pour three.'); // not mutated
    expect(bodySchemaFor('LINKEDIN_POST').safeParse(next).success).toBe(true);
  });

  it('a carousel slide edit keeps the body valid', () => {
    const next = applyFields(
      CAROUSEL,
      { 'slides.4.body': 'Sweet and long' },
      bodyToFields(CAROUSEL),
    ) as typeof CAROUSEL;
    expect(next.slides[4]).toEqual({
      headline: 'Five',
      body: 'Sweet and long',
    });
    expect(bodySchemaFor('CAROUSEL').safeParse(next).success).toBe(true);
  });

  it('a key that is not a field is ignored', () => {
    const next = applyFields(
      LINKEDIN,
      { 'paragraphs.9': 'x', nope: 'y' },
      bodyToFields(LINKEDIN),
    );
    expect(next).toEqual(LINKEDIN);
  });

  it('only real changes count as edits', () => {
    const fields = bodyToFields(LINKEDIN);
    expect(
      changedEdits(fields, { hook: LINKEDIN.hook, cta: 'Book now.' }),
    ).toEqual({ cta: 'Book now.' });
  });
});

describe('the shared actions and addresses', () => {
  it('every item has the same actions', () => {
    expect([...REVIEW_ACTIONS]).toEqual([
      'back',
      'edit',
      'save',
      'regenerate',
      'submit',
      'approve',
      'reject',
      'schedule',
    ]);
  });

  it('unsaved edits are kept per item and per version', () => {
    const a = editsStorageKey({
      kind: 'content',
      id: 'd1',
      updatedAt: '2026-10-13T10:00:00.000Z',
    });
    expect(a).not.toBe(
      editsStorageKey({
        kind: 'content',
        id: 'd1',
        updatedAt: '2026-10-13T11:00:00.000Z',
      }),
    );
    expect(a).not.toBe(
      editsStorageKey({
        kind: 'outreach',
        id: 'd1',
        updatedAt: '2026-10-13T10:00:00.000Z',
      }),
    );
    expect(reviewHref('outreach', 'm1')).toBe('/dashboard/review/outreach/m1');
  });
});

describe('reading order does not depend on how the body was stored', () => {
  it('fields follow the format, even when the keys come back shortest-first (as Postgres stores them)', () => {
    const stored = {
      cta: 'Book.',
      altText: '',
      caption: 'New rye.',
      hashtags: ['rye'],
    };
    expect(bodyToFields(stored).map((f) => f.key)).toEqual([
      'caption',
      'cta',
      'hashtags',
      'altText',
    ]);
    const slide = bodyToFields({
      title: 'T',
      slides: [{ body: 'b', headline: 'h' }],
    });
    expect(slide.map((f) => f.key)).toEqual([
      'title',
      'slides.0.headline',
      'slides.0.body',
    ]);
  });
});
