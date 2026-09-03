import { describe, it, expect } from 'vitest';

import { ONBOARDING_STEPS, ONBOARDING_STEP_IDS, onboardingStep } from '@/lib/onboarding';
import {
  brandAssetsSchema,
  marketingProfileSchema,
  hasBrandAssets,
  hasMarketingProfile,
} from '@/lib/validations/profile';
import { audienceToPrompt } from '@/server/content/audience';

/**
 * Onboarding has one job: at every moment, the user knows what to do next.
 *
 * The rules below are the ones that make that true. Each is here because
 * breaking it silently produces a checklist that looks fine and helps nobody —
 * a step with no destination, two steps competing for "do this now", or a
 * "why" that describes the feature instead of what the user gets from it.
 */
describe('onboarding steps', () => {
  it('covers the whole sequence, in order', () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
  });

  it('sends every step somewhere real', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.href.startsWith('/dashboard'), `${step.id} goes nowhere`).toBe(true);
      expect(step.cta.length).toBeGreaterThan(0);
    }
  });

  it('gives every step a reason stated as an outcome', () => {
    for (const step of ONBOARDING_STEPS) {
      // A "why" is the difference between a chore and two minutes well spent,
      // so it has to say something — a restated title does not.
      expect(step.why.length, `${step.id} has no reason`).toBeGreaterThan(30);
      expect(step.why.toLowerCase()).not.toBe(step.title.toLowerCase());
    }
  });

  it('asks only for the business information up front', () => {
    // Aura cannot write anything without knowing the company. Everything after
    // that improves the output, and marking it required would turn the
    // checklist into a wall between the user and the product.
    const required = ONBOARDING_STEPS.filter((s) => s.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.id).toBe('business');
  });

  it('has no duplicate destinations, so no step can be done by doing another', () => {
    const hrefs = ONBOARDING_STEPS.map((s) => s.href);
    // /dashboard appears once (the final review step) and nowhere else.
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('resolves every declared id', () => {
    for (const id of ONBOARDING_STEP_IDS) {
      expect(onboardingStep(id).id).toBe(id);
    }
  });
});

describe('brand assets', () => {
  it('accepts a hex colour with or without the hash', () => {
    const parsed = brandAssetsSchema.parse({ primaryColor: '1d4ed8' });
    expect(parsed.primaryColor).toBe('#1d4ed8');
  });

  it('expands the three-character shorthand', () => {
    // A user pasting #fff must not produce a colour string that only some
    // consumers understand.
    expect(brandAssetsSchema.parse({ primaryColor: '#FFF' }).primaryColor).toBe('#ffffff');
  });

  it('rejects anything that is not a colour', () => {
    expect(() => brandAssetsSchema.parse({ primaryColor: 'blue' })).toThrow();
    expect(() => brandAssetsSchema.parse({ primaryColor: '#12345' })).toThrow();
  });

  it('treats an empty field as unset rather than an error', () => {
    // Clearing a colour input is a normal thing to do, not a validation failure.
    const parsed = brandAssetsSchema.parse({ primaryColor: '', logoAssetId: '' });
    expect(parsed.primaryColor).toBeUndefined();
    expect(hasBrandAssets(parsed)).toBe(false);
  });

  it('counts the step done once anything is supplied', () => {
    expect(hasBrandAssets(brandAssetsSchema.parse({ logoAssetId: 'l123' }))).toBe(true);
    expect(hasBrandAssets(brandAssetsSchema.parse({ accentColor: '#abc' }))).toBe(true);
    expect(hasBrandAssets(null)).toBe(false);
  });
});

describe('audience and goals', () => {
  it('counts the step done on either half', () => {
    expect(hasMarketingProfile(marketingProfileSchema.parse({ audience: 'Ops leads' }))).toBe(true);
    expect(hasMarketingProfile(marketingProfileSchema.parse({ goals: '15 demos' }))).toBe(true);
    // Channels alone say where to publish, not who for or why — not enough.
    expect(
      hasMarketingProfile(marketingProfileSchema.parse({ channels: ['LinkedIn'] })),
    ).toBe(false);
  });

  it('rejects a channel the planner cannot generate for', () => {
    expect(() => marketingProfileSchema.parse({ channels: ['Carrier pigeon'] })).toThrow();
  });
});

describe('audienceToPrompt', () => {
  const base = { roleTitles: [], industries: [], companyStages: [], sources: [] };

  it('says so plainly when nothing is known', () => {
    // The failure mode to avoid is inventing a persona nobody described.
    expect(audienceToPrompt(null)).toContain('has not described its buyers');
  });

  it('carries the user’s own sentence through verbatim', () => {
    // The specifics are the whole value — paraphrasing into tags loses them.
    const stated = 'Ops leads who still run scheduling in spreadsheets';
    const prompt = audienceToPrompt({ ...base, stated });
    expect(prompt).toContain(stated);
  });

  it('puts the stated audience ahead of the inferred one', () => {
    const prompt = audienceToPrompt({
      ...base,
      stated: 'Founders at pre-seed hardware startups',
      roleTitles: ['Head of Marketing'],
    });
    expect(prompt.indexOf('pre-seed hardware')).toBeLessThan(
      prompt.indexOf('Head of Marketing'),
    );
    // The inferred detail is kept, demoted rather than discarded.
    expect(prompt).toContain('They are typically');
  });

  it('still describes a reader when only tags exist', () => {
    const prompt = audienceToPrompt({ ...base, roleTitles: ['CFO'] });
    expect(prompt).toContain('Your reader is CFO');
  });

  it('tells the model the goal is not for publication', () => {
    // A post that recites "we want 15 demos" is the exact misreading of this
    // field, so the instruction against it must always ship with the goal.
    const prompt = audienceToPrompt({ ...base, goals: 'Book 15 demos a month' });
    expect(prompt).toContain('Book 15 demos a month');
    expect(prompt).toContain('Never state the goal in the post itself');
  });

  it('omits the goal section entirely when there is no goal', () => {
    expect(audienceToPrompt({ ...base, roleTitles: ['CFO'] })).not.toContain(
      'WHAT THIS CONTENT IS FOR',
    );
  });
});
