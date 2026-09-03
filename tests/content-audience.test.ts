import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  audienceToPrompt,
  BUSINESS_FOCUS_RULES,
  type AudienceProfile,
} from '@/server/content/audience';

/**
 * Business- and audience-focused content.
 *
 * The generator knew the company's voice, its knowledge and the topic — but
 * never the READER. With no audience a model writes ABOUT a subject rather than
 * TO a person, which is precisely what "generic and technical" means in
 * practice: accurate, well-formed, addressed to nobody.
 */

const AUDIENCE: AudienceProfile = {
  roleTitles: ['Head of Marketing', 'VP Growth'],
  industries: ['B2B SaaS', 'fintech'],
  companyStages: ['Series A', '50-200'],
  sources: ['outreach targeting'],
};

describe('audienceToPrompt', () => {
  it('names the reader as a person, not a list of attributes', () => {
    // "Your reader is a Head of Marketing" moves output far more than
    // "audience: marketing, saas, series-a".
    const prompt = audienceToPrompt(AUDIENCE);
    expect(prompt).toContain('Your reader is');
    expect(prompt).toContain('Head of Marketing');
    expect(prompt).toContain('B2B SaaS');
    expect(prompt).toContain('Series A');
  });

  it('ties every claim to something the reader is measured on', () => {
    const prompt = audienceToPrompt(AUDIENCE);
    expect(prompt).toMatch(/revenue|cost|risk|time|capacity/i);
  });

  it('falls back to a stated general reader rather than inventing a persona', () => {
    // A workspace that has not described its buyers gets an honest default,
    // not a fabricated ICP.
    const prompt = audienceToPrompt(null);
    expect(prompt).toContain('has not described its buyers');
    expect(prompt).toMatch(/business decision-maker/i);
  });

  it('handles a partial profile without producing broken sentences', () => {
    const rolesOnly = audienceToPrompt({
      roleTitles: ['Founder'],
      industries: [],
      companyStages: [],
      sources: [],
    });
    expect(rolesOnly).toContain('Founder');
    expect(rolesOnly).not.toContain('working in .');
    expect(rolesOnly).not.toContain('undefined');

    const industryOnly = audienceToPrompt({
      roleTitles: [],
      industries: ['logistics'],
      companyStages: [],
      sources: [],
    });
    expect(industryOnly).toContain('logistics');
    expect(industryOnly).toContain('business decision-makers');
  });
});

describe('BUSINESS_FOCUS_RULES', () => {
  it('bans the hype vocabulary that makes copy read as generic', () => {
    for (const word of [
      'revolutionary',
      'cutting-edge',
      'seamless',
      'game-changing',
      'leverage',
      'unlock',
    ]) {
      expect(BUSINESS_FOCUS_RULES.toLowerCase()).toContain(word);
    }
  });

  it('bans the specific throat-clearing openings, not just "be specific"', () => {
    // A model already agrees with "be specific" and ignores it. A named banned
    // phrase is a rule it can actually follow.
    //
    // Whitespace-normalised: the rules are hard-wrapped for readability, so a
    // banned phrase can straddle a line break. The assertion is about the
    // content being present, not about where it happens to wrap.
    const flat = BUSINESS_FOCUS_RULES.replace(/\s+/g, ' ');
    expect(flat).toContain("In today's fast-paced world");
    expect(flat).toContain('We are excited to announce');
    expect(flat).toContain('It is no secret that');
  });

  it('subordinates technical detail to business outcome rather than banning it', () => {
    // Technical content is not the enemy — technical content that never says
    // why it matters is.
    expect(BUSINESS_FOCUS_RULES).toContain('Technical detail is allowed ONLY');
    expect(BUSINESS_FOCUS_RULES).toMatch(/business (consequence|outcome)/i);
  });

  it('prefers a narrower true claim over a broad empty one', () => {
    // The anti-hallucination direction: when grounding runs out, get smaller,
    // do not get vaguer.
    expect(BUSINESS_FOCUS_RULES).toMatch(/smaller true claim/i);
  });
});
