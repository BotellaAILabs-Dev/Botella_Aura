import { describe, expect, it } from 'vitest';

import {
  detailProblem,
  detailsOf,
  makeDetail,
  normaliseDetails,
  renderDetails,
  unconfirmedDetails,
  withDetails,
  type BusinessFacts,
} from '@/lib/post-details';
import { checkQuality } from '@/lib/content-quality';
import { bodyToFields } from '@/lib/review-item';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import type { ContentDraft } from '@prisma/client';

/**
 * Post details (lib/post-details.ts): the website, address, phone and email a
 * post carries — per version, never written by the AI, confirmed by a person.
 */

const FACTS: BusinessFacts = {
  website: 'https://leithcellar.example',
  address: '12 Harbour Street, Leith',
  phone: '+44 131 496 0000',
  email: null,
};
const POST = {
  hook: 'Our Friday tasting is back',
  paragraphs: ['One.', 'Two.', 'Three.'],
  cta: 'Book a seat',
  hashtags: ['wine'],
};
const draft = (body: unknown) => ({ type: 'LINKEDIN_POST', body }) as unknown as ContentDraft;
const QC = {
  limits: { maxChars: 3000, ctaExpected: true } as never,
  sources: '',
  avoid: [],
  alcohol: false,
};

describe('detail validation', () => {
  it('accepts real values and explains a wrong one', () => {
    expect(detailProblem('website', 'https://leithcellar.example/tasting')).toBeNull();
    expect(detailProblem('website', 'leithcellar')).toMatch(/full web address/);
    expect(detailProblem('website', 'javascript:alert(1)')).not.toBeNull();
    expect(detailProblem('phone', '+44 131 496 0000')).toBeNull();
    expect(detailProblem('phone', 'call us')).toMatch(/phone/);
    expect(detailProblem('email', 'hello@leithcellar.example')).toBeNull();
    expect(detailProblem('email', 'hello@')).toMatch(/email/);
    expect(detailProblem('address', 'Leith')).toMatch(/full address/);
  });
});

describe('where a detail came from', () => {
  it('is "profile" (pre-approved) only when it is exactly the business’s value', () => {
    expect(makeDetail('phone', '+44 131 496 0000', FACTS, false)).toEqual({ value: '+44 131 496 0000', source: 'profile', confirmed: true });
    expect(makeDetail('phone', '+44 7700 900123', FACTS, false)).toEqual({ value: '+44 7700 900123', source: 'user', confirmed: false });
    expect(makeDetail('phone', '+44 7700 900123', FACTS, true).confirmed).toBe(true);
  });

  it('cannot be faked by a client: the server re-derives it', () => {
    const forged = normaliseDetails({ phone: { value: '+44 7700 900123', source: 'profile', confirmed: false } }, FACTS);
    expect(forged.phone).toEqual({ value: '+44 7700 900123', source: 'user', confirmed: false });
    // A forged "profile" claim never counts as the person's confirmation either.
    const forgedConfirmed = normaliseDetails({ phone: { value: '+44 7700 900123', source: 'profile', confirmed: true } }, FACTS);
    expect(forgedConfirmed.phone?.confirmed).toBe(false);
  });
});

describe('approval', () => {
  it('a typed, unconfirmed detail blocks approval; a confirmed or saved one does not', () => {
    const typed = withDetails(POST, { email: { value: 'events@leithcellar.example', source: 'user', confirmed: false } });
    const report = checkQuality('LINKEDIN_POST', typed, QC);
    expect(unconfirmedDetails(detailsOf(typed))).toEqual(['email']);
    expect(report.approvable).toBe(false);
    expect(report.issues.find((i) => i.code === 'details-unconfirmed')?.message).toMatch(/email/);

    const confirmed = withDetails(POST, { email: { value: 'events@leithcellar.example', source: 'user', confirmed: true } });
    expect(checkQuality('LINKEDIN_POST', confirmed, QC).issues.some((i) => i.code === 'details-unconfirmed')).toBe(false);
    const saved = withDetails(POST, { phone: { value: FACTS.phone!, source: 'profile', confirmed: true } });
    expect(checkQuality('LINKEDIN_POST', saved, QC).issues.some((i) => i.code === 'details-unconfirmed')).toBe(false);
  });

  it('details do not count as invented facts in the copy checks', () => {
    const body = withDetails(POST, { phone: { value: FACTS.phone!, source: 'profile', confirmed: true } });
    const codes = checkQuality('LINKEDIN_POST', body, QC).issues.map((i) => i.code);
    expect(codes).not.toContain('unsupported-number');
  });
});

describe('rendering', () => {
  const body = withDetails(POST, {
    website: { value: 'https://leithcellar.example/tasting', source: 'user', confirmed: true },
    phone: { value: FACTS.phone!, source: 'profile', confirmed: true },
  });

  it('details follow the call to action, in a fixed order', () => {
    expect(renderDetails(detailsOf(body))).toEqual(['https://leithcellar.example/tasting', `Phone: ${FACTS.phone}`]);
    const text = renderForManual(draft(body));
    expect(text.indexOf('Book a seat')).toBeLessThan(text.indexOf('https://leithcellar.example/tasting'));
    expect(text.indexOf(`Phone: ${FACTS.phone}`)).toBeLessThan(text.indexOf('#wine'));
  });

  it('are published with a LinkedIn post', () => {
    expect(renderLinkedInCommentary(draft(body))).toContain('https://leithcellar.example/tasting');
  });

  it('are left out where text is analysed or given to the AI', () => {
    expect(renderForManual(draft(body), { details: false })).not.toContain('leithcellar.example');
  });

  it('a body without details renders exactly as before', () => {
    expect(renderForManual(draft(POST))).toBe(renderForManual(draft(withDetails(POST, {}))));
  });
});

describe('editing', () => {
  it('details are not offered as free-text fields on the review screen', () => {
    const body = withDetails(POST, { phone: { value: FACTS.phone!, source: 'profile', confirmed: true } });
    expect(bodyToFields(body).some((f) => f.key.startsWith('details'))).toBe(false);
  });

  it('withDetails replaces only the details', () => {
    const body = withDetails(POST, { phone: { value: FACTS.phone!, source: 'profile', confirmed: true } });
    expect(withDetails(body, null)).toEqual(POST);
  });
});
