import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  brandContextToPrompt,
  hasBrandContext,
  type BrandContext,
} from '@/server/brand/brand-context.service';

/**
 * The shared brand-context preamble.
 *
 * Brand knowledge used to be assembled independently at every AI call site,
 * and each one picked a different subset — brand voice reached eight of ten
 * workflows, the business description and audience reached two. A user who
 * described their company once still got campaign plans, outreach and image
 * briefs that had never heard of it.
 *
 * These tests pin the two properties that make one shared builder safe to put
 * in front of every workflow: it must carry everything the workspace supplied,
 * and it must degrade to nothing when the workspace has supplied nothing.
 */

function context(overrides: Partial<BrandContext> = {}): BrandContext {
  return {
    company: {
      id: 'c1',
      name: 'Verdant Roastery',
      industry: 'Food & beverage',
      website: null,
    },
    business: {
      description: 'We roast single-origin coffee in small batches.',
      offerings: 'Whole bean subscriptions',
    },
    audience: {
      roleTitles: [],
      industries: [],
      companyStages: [],
      stated: 'People who already own a grinder.',
      mode: 'B2C',
      sources: ['audience settings'],
    },
    voice: null,
    knowledge: [],
    ...overrides,
  };
}

describe('brandContextToPrompt', () => {
  it('carries the business description into the prompt', () => {
    const out = brandContextToPrompt(context());
    expect(out).toContain('single-origin coffee');
    expect(out).toContain('Whole bean subscriptions');
  });

  it('carries the stated audience verbatim', () => {
    const out = brandContextToPrompt(context());
    expect(out).toContain('already own a grinder');
  });

  /**
   * Market mode is the largest fork in how anything is written, and it has to
   * survive into every workflow — not just content generation.
   */
  it('applies consumer writing rules for a B2C workspace', () => {
    const out = brandContextToPrompt(context());
    expect(out).toMatch(/taste|looks|feel|experience/i);
    // The B2B framing must not leak into a consumer brand's prompt.
    expect(out).not.toContain('measured on — revenue, cost, risk');
  });

  it('applies business-buyer rules for a B2B workspace', () => {
    const out = brandContextToPrompt(
      context({
        audience: {
          roleTitles: ['Head of Operations'],
          industries: ['Logistics'],
          companyStages: [],
          stated: 'Ops leads still running scheduling in spreadsheets.',
          mode: 'B2B',
          sources: [],
        },
      }),
    );
    expect(out).toContain('Ops leads');
    expect(out).toMatch(/revenue|cost|risk/i);
  });

  /**
   * The safety property: a workspace that has said nothing must not have
   * anything asserted about it.
   *
   * What remains is the generic audience fallback and the default writing
   * rules — both are instruction rather than claims, and both were already
   * applied at the content generator before this module existed. What must NOT
   * appear is a company-specific block describing a business nobody described.
   */
  it('asserts nothing about a workspace that has said nothing', () => {
    const out = brandContextToPrompt(
      context({ business: null, audience: null, voice: null, knowledge: [] }),
    );
    expect(out).not.toContain('WHAT THIS COMPANY DOES');
    expect(out).not.toContain('COMPANY KNOWLEDGE');
    expect(out).not.toContain("in the company's own words");
    // It says so plainly rather than inventing a persona.
    expect(out).toContain('has not described its buyers yet');
  });

  /** A planning workflow gets identity and reader without the prose rules. */
  it('is compact for a planning workflow with an unconfigured workspace', () => {
    const out = brandContextToPrompt(
      context({ business: null, audience: null, voice: null, knowledge: [] }),
      { includeWritingRules: false, includeVoice: false },
    );
    expect(out.length).toBeLessThan(400);
  });

  it('returns an empty string for a missing context rather than throwing', () => {
    expect(brandContextToPrompt(null)).toBe('');
  });

  it('omits writing rules when a planning workflow asks it to', () => {
    const out = brandContextToPrompt(context(), { includeWritingRules: false });
    expect(out).toContain('single-origin coffee');
    expect(out).not.toContain('HOW TO WRITE THIS');
  });

  it('omits the voice block on request, keeping identity and audience', () => {
    const out = brandContextToPrompt(context(), { includeVoice: false });
    expect(out).toContain('single-origin coffee');
    expect(out).toContain('already own a grinder');
  });

  it('labels retrieved knowledge as the only quotable facts', () => {
    const out = brandContextToPrompt(
      context({
        knowledge: [
          {
            id: 'k1',
            title: 'Product sheet',
            content: 'Our Ethiopia lot is washed and rested for 30 days.',
            sourceType: 'UPLOAD',
            category: null,
            score: 1,
          },
        ],
      }),
    );
    expect(out).toContain('COMPANY KNOWLEDGE');
    expect(out).toContain('Do not invent');
  });

  /** Identity must precede audience: tone before subject writes about nothing. */
  it('orders identity before audience', () => {
    const out = brandContextToPrompt(context());
    expect(out.indexOf('WHAT THIS COMPANY DOES')).toBeLessThan(
      out.indexOf('WHO YOU ARE WRITING FOR'),
    );
  });
});

describe('hasBrandContext', () => {
  it('is false for a workspace that has supplied nothing', () => {
    expect(
      hasBrandContext(
        context({ business: null, audience: null, voice: null, knowledge: [] }),
      ),
    ).toBe(false);
  });

  it('is false for a missing context', () => {
    expect(hasBrandContext(null)).toBe(false);
  });

  it('is true once a description exists', () => {
    expect(hasBrandContext(context({ audience: null, voice: null }))).toBe(true);
  });

  /**
   * Market mode alone counts. A workspace that has only said "we sell to
   * consumers" has stated the most important thing about its reader.
   */
  it('is true when only the market mode has been chosen', () => {
    expect(
      hasBrandContext(
        context({
          business: null,
          voice: null,
          audience: {
            roleTitles: [],
            industries: [],
            companyStages: [],
            mode: 'B2C',
            sources: [],
          },
        }),
      ),
    ).toBe(true);
  });
});
