import { describe, it, expect } from 'vitest';

import {
  checkCompliance,
  compliancePolicySchema,
  defaultPolicy,
  policyHash,
  policyToPrompt,
  readPolicy,
  type ComplianceInput,
  type CompliancePolicy,
} from '@/lib/compliance-policy';
import {
  bodyHash,
  combineReview,
  isReviewCurrent,
  REVIEW_DIMENSIONS,
} from '@/lib/content-review';

/**
 * Content compliance & policy checks: configurable rules for the content and
 * channel, checked before approval.
 */

const policy = (patch: Partial<CompliancePolicy> = {}): CompliancePolicy => ({
  ...defaultPolicy(false),
  ...patch,
});

const run = (text: string, over: Partial<ComplianceInput> = {}) =>
  checkCompliance({
    type: 'LINKEDIN_POST',
    platform: 'LINKEDIN',
    text,
    cta: '',
    policy: policy(),
    alcohol: false,
    website: 'https://www.oakbarrel.example',
    competitors: ['Big Box Liquor'],
    rules: [],
    claims: null,
    ...over,
  });
const ids = (r: ReturnType<typeof run>) => r.findings.map((f) => f.ruleId);
const finding = (r: ReturnType<typeof run>, id: string) =>
  r.findings.find((f) => f.ruleId === id);

describe('the policy is configurable data', () => {
  it('defaults: general pack on, alcohol automatic, a promotion disclaimer — and the responsible line for alcohol', () => {
    const p = defaultPolicy(false);
    expect(p.packs).toEqual({
      general: true,
      alcohol: 'auto',
      health: false,
      financial: false,
    });
    expect(p.disclaimers.map((d) => d.text)).toEqual(['Terms apply.']);
    expect(defaultPolicy(true).disclaimers.map((d) => d.text)).toEqual([
      'Terms apply.',
      'Please enjoy responsibly.',
    ]);
    expect(p.manualReview).toMatchObject({
      competitorMentions: true,
      giveaways: true,
      prices: false,
    });
  });

  it('a stored policy is used; an unreadable one falls back to the defaults', () => {
    const custom = compliancePolicySchema.parse({
      prohibited: [{ id: 'a', phrase: 'cheapest' }],
    });
    expect(readPolicy(custom, false).prohibited[0]!.phrase).toBe('cheapest');
    expect(readPolicy({ prohibited: 'nope' }, false)).toEqual(
      defaultPolicy(false),
    );
    expect(readPolicy(null, true)).toEqual(defaultPolicy(true));
  });

  it('changing the rules changes their fingerprint', () => {
    const a = policyHash(policy(), false);
    expect(policyHash(policy(), false)).toBe(a);
    expect(
      policyHash(policy({ packs: { ...policy().packs, health: true } }), false),
    ).not.toBe(a);
    // "auto" alcohol follows the business.
    expect(policyHash(policy(), true)).not.toBe(a);
  });
});

describe('prohibited and unsupported claims', () => {
  it('built-in: risk-free and miracle promises fail; a guarantee needs review', () => {
    const r = run(
      'Our risk-free tasting club. A miracle in every glass. Satisfaction guaranteed.',
    );
    expect(finding(r, 'general.risk-free')?.outcome).toBe('fail');
    expect(finding(r, 'general.miracle')?.outcome).toBe('fail');
    expect(finding(r, 'general.guarantee')?.outcome).toBe('review');
    expect(finding(r, 'general.risk-free')?.quote).toBe(
      'Our risk-free tasting club.',
    );
    expect(r.status).toBe('fail');
  });

  it('turning the pack off turns its rules off', () => {
    const r = run('Our risk-free tasting club.', {
      policy: policy({ packs: { ...policy().packs, general: false } }),
    });
    expect(ids(r)).not.toContain('general.risk-free');
  });

  it('the workspace’s own words: whole words only, block or review as set', () => {
    const p = policy({
      prohibited: [
        {
          id: 'cheap',
          phrase: 'cheap',
          severity: 'block',
          reason: 'we compete on curation',
        },
        { id: 'best', phrase: 'best in town', severity: 'review', reason: '' },
      ],
    });
    const hit = run('Cheap bourbon? No. The best in town, picked by us.', {
      policy: p,
    });
    expect(finding(hit, 'workspace.prohibited.cheap')).toMatchObject({
      outcome: 'fail',
      source: 'workspace',
      message: 'Uses “cheap” — we compete on curation.',
    });
    expect(finding(hit, 'workspace.prohibited.best')?.outcome).toBe('review');
    expect(
      ids(run('Not the cheapest, the ones we drink.', { policy: p })),
    ).not.toContain('workspace.prohibited.cheap');
  });

  it('health and financial packs, when on', () => {
    const p = policy({
      packs: { general: true, alcohol: 'auto', health: true, financial: true },
    });
    const r = run(
      'This tea cures anxiety. Clinically proven. Guaranteed returns on our fund, 8% interest.',
      { policy: p },
    );
    expect(finding(r, 'health.treats')?.outcome).toBe('fail');
    expect(finding(r, 'health.endorsement')?.outcome).toBe('review');
    expect(finding(r, 'financial.guaranteed-returns')?.outcome).toBe('fail');
    expect(finding(r, 'financial.risk-warning')?.outcome).toBe('fail');
    const ok = run('Our savings account pays 4% interest. Capital at risk.', {
      policy: p,
    });
    expect(ids(ok)).not.toContain('financial.risk-warning');
  });
});

describe('required disclaimers', () => {
  it('a promotion without “Terms apply” fails; the usual variants count', () => {
    expect(
      finding(
        run('20% off every bourbon this weekend.'),
        'workspace.disclaimer.promo-terms',
      )?.outcome,
    ).toBe('fail');
    expect(
      ids(run('20% off every bourbon this weekend. T&Cs apply.')),
    ).not.toContain('workspace.disclaimer.promo-terms');
    expect(ids(run('New arrivals this weekend.'))).not.toContain(
      'workspace.disclaimer.promo-terms',
    );
  });

  it('alcohol: the responsible-drinking line is required, “drink responsibly” counts', () => {
    const p = defaultPolicy(true);
    expect(
      finding(
        run('New bourbon on the shelf.', { policy: p, alcohol: true }),
        'workspace.disclaimer.responsible-drinking',
      )?.outcome,
    ).toBe('fail');
    expect(
      ids(
        run('New bourbon on the shelf. Drink responsibly.', {
          policy: p,
          alcohol: true,
        }),
      ),
    ).not.toContain('workspace.disclaimer.responsible-drinking');
  });

  it('a term-triggered disclaimer, limited to formats, with its severity', () => {
    const p = policy({
      disclaimers: [
        {
          id: 'ship',
          text: 'Delivery to over-21s only.',
          when: 'terms',
          terms: ['delivery'],
          formats: ['EMAIL'],
          severity: 'review',
        },
      ],
    });
    expect(
      finding(
        run('Free delivery on Fridays.', {
          policy: p,
          type: 'EMAIL',
          platform: null,
        }),
        'workspace.disclaimer.ship',
      )?.outcome,
    ).toBe('review');
    expect(ids(run('Free delivery on Fridays.', { policy: p }))).not.toContain(
      'workspace.disclaimer.ship',
    );
    expect(
      ids(
        run('Free delivery on Fridays. Delivery to over-21s only.', {
          policy: p,
          type: 'EMAIL',
          platform: null,
        }),
      ),
    ).not.toContain('workspace.disclaimer.ship');
  });
});

describe('channel restrictions', () => {
  it('an Instagram giveaway must carry the Meta release; elsewhere it does not', () => {
    const text = 'Giveaway! Win a bottle of our rye. Terms apply.';
    expect(
      finding(
        run(text, { type: 'IMAGE_POST', platform: 'INSTAGRAM' }),
        'channel.meta-giveaway-release',
      )?.outcome,
    ).toBe('fail');
    expect(
      ids(
        run(
          `${text} This promotion is not sponsored, endorsed or administered by, or associated with, Instagram.`,
          { type: 'IMAGE_POST', platform: 'INSTAGRAM' },
        ),
      ),
    ).not.toContain('channel.meta-giveaway-release');
    expect(ids(run(text))).not.toContain('channel.meta-giveaway-release');
  });

  it('engagement bait needs review; Instagram links are advice; ads may not assert personal attributes', () => {
    expect(
      finding(
        run('Comment YES below if you want a tasting!'),
        'channel.engagement-bait',
      )?.outcome,
    ).toBe('review');
    expect(
      finding(
        run('See www.oakbarrel.example/tastings', {
          type: 'IMAGE_POST',
          platform: 'INSTAGRAM',
        }),
        'channel.instagram-links',
      )?.outcome,
    ).toBe('warn');
    expect(
      finding(
        run('Are you single? Meet people at our tasting.', {
          type: 'AD',
          platform: 'FACEBOOK',
        }),
        'channel.ad-personal-attributes',
      )?.outcome,
    ).toBe('fail');
  });

  it('an email subject that shouts is advice, not a block', () => {
    const r = run('Hello.', {
      type: 'EMAIL',
      platform: null,
      subject: 'HUGE BOURBON SALE TODAY!!!',
    });
    expect(finding(r, 'channel.email-subject-shouting')?.outcome).toBe('warn');
  });

  it('alcohol ads and free drinks need a person', () => {
    const p = defaultPolicy(true);
    const r = run(
      'Free shots for the first ten guests. Please enjoy responsibly.',
      { policy: p, alcohol: true, type: 'AD', platform: 'FACEBOOK' },
    );
    expect(finding(r, 'alcohol.free-drinks')?.outcome).toBe('review');
    expect(finding(r, 'alcohol.ad-audience')?.outcome).toBe('review');
    expect(r.packs).toContain('alcohol');
    expect(
      run('x', {
        policy: { ...p, packs: { ...p.packs, alcohol: 'off' } },
        alcohol: true,
      }).packs,
    ).not.toContain('alcohol');
  });
});

describe('CTA requirements', () => {
  it('banned calls to action fail; required CTAs must be there', () => {
    const p = policy({
      cta: {
        bannedPhrases: ['DM us'],
        allowedLinkDomains: [],
        requiredFor: ['IMAGE_POST'],
      },
    });
    expect(
      finding(
        run('Questions? DM us.', { policy: p }),
        'workspace.cta.banned.dm-us',
      )?.outcome,
    ).toBe('fail');
    expect(
      finding(
        run('New rye.', {
          policy: p,
          type: 'IMAGE_POST',
          platform: 'INSTAGRAM',
        }),
        'workspace.cta.required',
      )?.outcome,
    ).toBe('fail');
    expect(
      ids(
        run('New rye.', {
          policy: p,
          type: 'IMAGE_POST',
          platform: 'INSTAGRAM',
          cta: 'Visit us Friday.',
        }),
      ),
    ).not.toContain('workspace.cta.required');
  });

  it('links go to the business’s own domains (subdomains too) or an allowed one; others need review', () => {
    const p = policy({
      cta: {
        bannedPhrases: [],
        allowedLinkDomains: ['eventbrite.com'],
        requiredFor: [],
      },
    });
    const r = run(
      'Book at https://shop.oakbarrel.example/rye or https://www.eventbrite.com/e/1 or https://bit.ly/x.',
      { policy: p },
    );
    expect(
      r.findings
        .filter((f) => f.ruleId.startsWith('workspace.cta.link.'))
        .map((f) => f.ruleId),
    ).toEqual(['workspace.cta.link.bit.ly']);
  });
});

describe('manual-review triggers', () => {
  it('competitors, giveaways, prices, formats, channels and words', () => {
    const p = policy({
      manualReview: {
        formats: ['AD'],
        channels: ['X'],
        terms: ['award'],
        competitorMentions: true,
        prices: true,
        giveaways: true,
      },
    });
    const r = run(
      'Unlike Big Box Liquor, our award shelf starts at $29. Enter our contest. Terms apply.',
      {
        policy: p,
        type: 'AD',
        platform: 'X',
      },
    );
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        'workspace.review.format.AD',
        'workspace.review.channel.X',
        'workspace.review.term.award',
        'workspace.review.competitor',
        'workspace.review.price',
        'workspace.review.giveaway',
      ]),
    );
    expect(
      r.findings
        .filter((f) => f.category === 'manual_review')
        .every((f) => f.outcome === 'review'),
    ).toBe(true);
    expect(r.status).toBe('review');
  });

  it('switched off, they stay quiet', () => {
    const p = policy({
      manualReview: {
        formats: [],
        channels: [],
        terms: [],
        competitorMentions: false,
        prices: false,
        giveaways: false,
      },
    });
    expect(
      run('Unlike Big Box Liquor, from $29.', { policy: p }).findings,
    ).toEqual([]);
  });
});

describe('factual claims and the existing checks, in the same report', () => {
  it('rule breaches and fact-check claims are categorised; style advice is not compliance', () => {
    const r = run('We are the only award-winning shop.', {
      rules: [
        {
          code: 'alcohol-excess',
          severity: 'block',
          message: 'Encourages excessive drinking.',
        },
        {
          code: 'robotic-phrase',
          severity: 'warn',
          message: 'Sounds machine-written.',
        },
        {
          code: 'unsupported-claim',
          severity: 'block',
          message: 'Unsupported.',
        },
      ],
      claims: [
        {
          text: 'We are the only award-winning shop.',
          status: 'unsupported',
          mustFix: true,
          reason: 'Nothing supports “only”.',
        },
        {
          text: 'We ship to Europe.',
          status: 'unverified',
          mustFix: false,
          reason: 'Only an unconfirmed detail.',
        },
      ],
    });
    expect(finding(r, 'rules.alcohol-excess')).toMatchObject({
      category: 'prohibited_claim',
      outcome: 'fail',
    });
    expect(ids(r)).not.toContain('rules.robotic-phrase');
    // The fact check decides factual claims when it ran.
    expect(ids(r)).not.toContain('rules.unsupported-claim');
    const facts = r.findings.filter((f) => f.category === 'factual');
    expect(facts.map((f) => f.outcome)).toEqual(['fail', 'review']);
    expect(r.checked.factual).toBe(2);
  });

  it('a clean piece passes, and says what was checked', () => {
    const r = run(
      'New small-batch rye on the shelf this week. Come and taste it.',
    );
    expect(r.status).toBe('pass');
    expect(Object.values(r.checked).reduce((a, b) => a + b, 0)).toBeGreaterThan(
      5,
    );
  });
});

describe('the writer is told the same rules', () => {
  it('prohibited words, disclaimers, CTAs and domains appear in the instructions', () => {
    const p = policy({
      prohibited: [
        { id: 'c', phrase: 'cheapest', severity: 'block', reason: '' },
      ],
      cta: {
        bannedPhrases: ['DM us'],
        allowedLinkDomains: ['eventbrite.com'],
        requiredFor: [],
      },
    });
    const text = policyToPrompt(p, false);
    expect(text).toContain('“cheapest”');
    expect(text).toContain(
      'On any promotion, discount, sale or giveaway, include this exact line: "Terms apply."',
    );
    expect(text).toContain('“DM us”');
    expect(text).toContain('eventbrite.com');
    expect(policyToPrompt(defaultPolicy(true), true)).toContain(
      'Always include this exact line: "Please enjoy responsibly."',
    );
  });
});

describe('in the review: failed checks block, review triggers flag', () => {
  const scores = REVIEW_DIMENSIONS.map((d) => ({
    dimension: d,
    score: 5,
    reason: 'fine',
  }));
  const review = (compliance: ReturnType<typeof run>) =>
    combineReview({
      rules: [],
      ctaChecked: false,
      factCheck: { status: 'verified', claims: [] },
      missing: [],
      ai: { dimensions: scores, issues: [], summary: '' },
      aiModel: 'm',
      aiUnavailable: null,
      text: 'x',
      bodyHash: bodyHash({ a: 1 }),
      trigger: 'manual',
      compliance,
    });

  it('a failed policy check fails the review on the right dimension, even with 5/5 from the model', () => {
    const r = review(
      run('Risk-free! Questions? DM us.', {
        policy: policy({
          cta: {
            bannedPhrases: ['DM us'],
            allowedLinkDomains: [],
            requiredFor: [],
          },
        }),
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(expect.arrayContaining(['compliance', 'cta']));
    expect(r.issues.find((i) => i.source === 'policy')?.severity).toBe(
      'blocker',
    );
  });

  it('a manual-review trigger marks it for a person; advice alone passes', () => {
    const r = review(run('Unlike Big Box Liquor, we pour it neat.'));
    expect(r.status).toBe('review_required');
    expect(r.humanReviewReasons.join(' ')).toMatch(
      /Compliance: Names a competitor/,
    );
    expect(
      review(
        run('See www.oakbarrel.example', {
          type: 'IMAGE_POST',
          platform: 'INSTAGRAM',
        }),
      ).status,
    ).toBe('pass');
  });

  it('a review made under other rules is out of date', () => {
    const c = run('Fine.');
    const r = review(c);
    expect(r.policyHash).toBe(c.policyHash);
    expect(isReviewCurrent(r, { a: 1 }, c.policyHash)).toBe(true);
    expect(isReviewCurrent(r, { a: 1 }, 'something-else')).toBe(false);
    expect(isReviewCurrent(r, { a: 1 })).toBe(true);
  });
});
