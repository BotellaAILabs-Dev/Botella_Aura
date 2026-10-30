import { describe, expect, it } from 'vitest';

import { briefCoverage, checkQuality } from '@/lib/content-quality';
import { playbookFor } from '@/lib/content-playbook';

/**
 * A first draft must be about what the person asked for, not just about the
 * business. Variations are already held to the original draft (topic-drift);
 * this holds the first draft to the person's own prompt.
 */

describe('briefCoverage', () => {
  it('passes a caption that answers the prompt', () => {
    const r = briefCoverage(
      'Diwali offer on the gift box subscription',
      'This Diwali, gift a box of fresh coffee — 20% off every gift box subscription until Sunday.',
    );
    expect(r.verdict).toBe('ok');
  });

  it('blocks a caption about something else entirely', () => {
    const r = briefCoverage(
      'Announce our new Hyderabad office opening',
      'Mornings are better with freshly roasted beans. Try our single-origin range today.',
    );
    expect(r.verdict).toBe('block');
    expect(r.missing).toEqual(expect.arrayContaining(['hyderabad', 'office', 'opening']));
  });

  it('warns when a long prompt is barely touched', () => {
    const r = briefCoverage(
      'Explain how Botella AI saves small business owners five hours weekly on scheduling social media posts',
      'Botella AI helps you grow. Marketing made simple for everyone.',
    );
    expect(r.verdict).toBe('warn');
  });

  it('stays quiet when the prompt names no subject', () => {
    expect(briefCoverage('Write something for Monday', 'Anything at all.').verdict).toBe('ok');
  });

  it('judges the subject, not the instructions around it', () => {
    const r = briefCoverage(
      'Write a short LinkedIn post for Friday about our new espresso blend',
      'Meet Midnight, our new espresso blend: dark chocolate, cherry, and a finish that lingers.',
    );
    expect(r.verdict).toBe('ok');
    expect(r.missing).not.toContain('write');
  });

  it('counts plural and singular as the same subject', () => {
    expect(briefCoverage('Tips for new subscribers', 'Three tips every new subscriber should know.').verdict).toBe('ok');
  });
});

describe('in the quality check', () => {
  const limits = playbookFor('LINKEDIN_POST', 'LINKEDIN').limits;
  const body = {
    hook: 'Mornings are better with freshly roasted beans.',
    paragraphs: ['Our single-origin range is roasted weekly.', 'Every bag ships in two days.', 'Taste the difference.'],
    cta: 'Order today',
    hashtags: [],
  };
  const ctx = { limits, sources: 'Roastery sells coffee.', avoid: [], alcohol: false };

  it('blocks a draft that ignores the prompt, so the repair pass rewrites it', () => {
    const r = checkQuality('LINKEDIN_POST', body, { ...ctx, brief: 'Announce our new Hyderabad office opening' });
    const issue = r.issues.find((i) => i.code === 'off-brief');
    expect(issue?.severity).toBe('block');
    expect(issue?.message).toMatch(/hyderabad/);
    expect(r.approvable).toBe(false);
  });

  it('does nothing when no prompt was given (trend or recommendation drafts)', () => {
    const r = checkQuality('LINKEDIN_POST', body, ctx);
    expect(r.issues.some((i) => i.code === 'off-brief')).toBe(false);
  });
});
