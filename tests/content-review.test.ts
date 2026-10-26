import { describe, it, expect } from 'vitest';

import {
  bodyHash,
  buildReviewerPrompt,
  combineReview,
  isReviewCurrent,
  REVIEW_DIMENSIONS,
  REVIEW_VERSION,
  reviewAsFeedback,
  reviewerOutputSchema,
  type ReviewerInput,
  type ReviewerOutput,
  type ReviewSignals,
} from '@/lib/content-review';

/**
 * The AI Reviewer: an independent, structured evaluation of a piece before it
 * enters approval — pass, needs human review, or fail.
 */

const TEXT =
  'Small-batch bourbon, picked by people who drink it. Come taste three new arrivals at Friday’s tasting, 6pm. Please enjoy responsibly.';

const allScores = (
  score: number,
  over: Partial<Record<string, number>> = {},
): ReviewerOutput => ({
  dimensions: REVIEW_DIMENSIONS.map((d) => ({
    dimension: d,
    score: over[d] ?? score,
    reason: `${d} reason`,
  })),
  issues: [],
  summary: 'Ready to go.',
});

const base = (over: Partial<ReviewSignals> = {}): ReviewSignals => ({
  rules: [],
  ctaChecked: true,
  factCheck: { status: 'verified', claims: [] },
  missing: [],
  ai: allScores(5),
  aiModel: 'test-model',
  aiUnavailable: null,
  text: TEXT,
  bodyHash: 'abc',
  trigger: 'generated',
  now: new Date('2026-10-13T10:00:00Z'),
  ...over,
});

describe('the review result is structured', () => {
  it('scores all ten dimensions, overall, with who assessed each', () => {
    const r = combineReview(base());
    expect(r.version).toBe(REVIEW_VERSION);
    expect(r.status).toBe('pass');
    expect(r.score).toBe(100);
    expect(r.dimensions.map((d) => d.dimension)).toEqual([
      ...REVIEW_DIMENSIONS,
    ]);
    expect(
      r.dimensions.find((d) => d.dimension === 'accuracy')!.assessedBy,
    ).toEqual(expect.arrayContaining(['rules', 'fact_check', 'reviewer']));
    expect(r.failed).toEqual([]);
    expect(r.humanReviewReasons).toEqual([]);
    expect(r.reviewer).toEqual({
      ran: true,
      model: 'test-model',
      unavailable: null,
    });
  });

  it('the output schema has no field for copy — a reviewer cannot hand back a rewrite', () => {
    const parsed = reviewerOutputSchema.parse({
      ...allScores(4),
      body: { caption: 'rewritten!' },
      rewrite: 'something else',
    });
    expect(parsed).not.toHaveProperty('body');
    expect(parsed).not.toHaveProperty('rewrite');
  });

  it('tolerates a model that answers scores as strings and odd severities', () => {
    const parsed = reviewerOutputSchema.parse({
      dimensions: [{ dimension: 'clarity', score: '4', reason: 'ok' }],
      issues: [
        { dimension: 'cta', severity: 'critical', problem: 'Vague CTA' },
      ],
    });
    expect(parsed.dimensions[0]!.score).toBe(4);
    expect(parsed.issues[0]!.severity).toBe('minor');
  });
});

describe('thresholds and states', () => {
  it('a dimension scored 2 fails the piece, and is named', () => {
    const r = combineReview(base({ ai: allScores(5, { audience_fit: 2 }) }));
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(['audience_fit']);
    expect(
      r.dimensions.find((d) => d.dimension === 'audience_fit'),
    ).toMatchObject({
      verdict: 'fail',
      score: 25,
    });
  });

  it('a dimension scored 3 needs a person', () => {
    const r = combineReview(base({ ai: allScores(5, { clarity: 3 }) }));
    expect(r.status).toBe('review_required');
    expect(r.humanReviewReasons[0]).toMatch(/^Clarity:/);
  });

  it('an overall score under the bar needs a person even when no dimension fails', () => {
    const r = combineReview(
      base({ ai: allScores(4, { relevance: 3, clarity: 3, cta: 3 }) }),
    );
    expect(r.failed).toEqual([]);
    expect(r.score!).toBeLessThan(75);
    expect(r.status).toBe('review_required');
  });

  it('an AI opinion alone never fails accuracy or compliance — it goes to a person', () => {
    const r = combineReview(
      base({ ai: allScores(5, { compliance: 1, accuracy: 2 }) }),
    );
    expect(r.failed).toEqual([]);
    expect(r.status).toBe('review_required');
    expect(
      r.dimensions.find((d) => d.dimension === 'compliance')!.verdict,
    ).toBe('review');
  });

  it('a rule breach always fails, whatever the reviewer scored', () => {
    const r = combineReview(
      base({
        rules: [
          {
            code: 'alcohol-excess',
            severity: 'block',
            message: 'Encourages excessive drinking (“bottomless”).',
          },
        ],
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(['compliance']);
    const c = r.dimensions.find((d) => d.dimension === 'compliance')!;
    expect(c.score).toBeLessThanOrEqual(25);
    expect(c.summary).toMatch(/excessive/);
    expect(r.issues[0]).toMatchObject({
      severity: 'blocker',
      source: 'rules',
      dimension: 'compliance',
    });
  });

  it('a rule warning is a minor issue, not a failure', () => {
    const r = combineReview(
      base({
        rules: [
          { code: 'hashtags', severity: 'warn', message: 'Use 3–5 hashtags.' },
        ],
      }),
    );
    expect(r.status).toBe('pass');
    expect(r.issues[0]).toMatchObject({
      severity: 'minor',
      dimension: 'channel_fit',
    });
  });

  it('a must-fix claim from the fact check fails accuracy; an unverified one needs a person', () => {
    const claim = (status: string, mustFix: boolean) => ({
      text: 'Bourbon prices rose 15% this year.',
      status,
      mustFix,
      reason: 'Says 15%, but evidence says 30%.',
    });
    const fail = combineReview(
      base({
        factCheck: {
          status: 'contradicted',
          claims: [claim('contradicted', true)] as never,
        },
      }),
    );
    expect(fail.status).toBe('fail');
    expect(fail.failed).toEqual(['accuracy']);
    const review = combineReview(
      base({
        factCheck: {
          status: 'needs_review',
          claims: [claim('unverified', false)] as never,
        },
      }),
    );
    expect(review.status).toBe('review_required');
    expect(review.issues[0]).toMatchObject({
      source: 'fact_check',
      severity: 'major',
    });
  });

  it('missing parts fail completeness', () => {
    const r = combineReview(base({ missing: ['cta'] }));
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(['completeness']);
  });

  it('when the reviewer cannot run, the rules still decide what they can and a person must look', () => {
    const r = combineReview(
      base({
        ai: null,
        aiModel: null,
        aiUnavailable: 'the AI provider is at its limit',
      }),
    );
    expect(r.status).toBe('review_required');
    expect(r.reviewer).toEqual({
      ran: false,
      model: null,
      unavailable: 'the AI provider is at its limit',
    });
    expect(r.dimensions.find((d) => d.dimension === 'relevance')!.verdict).toBe(
      'not_assessed',
    );
    expect(
      r.dimensions.find((d) => d.dimension === 'compliance')!.verdict,
    ).toBe('pass');
    expect(r.humanReviewReasons.join(' ')).toMatch(
      /did not run \(the AI provider is at its limit\)/,
    );
  });

  it('...but a rule breach still fails without it', () => {
    const r = combineReview(
      base({
        ai: null,
        aiUnavailable: 'x',
        rules: [
          {
            code: 'too-long',
            severity: 'block',
            message: 'Too long for Instagram.',
          },
        ],
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(['channel_fit']);
  });

  it('a dimension the reviewer skipped is not assessed, and named', () => {
    const ai = allScores(5);
    ai.dimensions = ai.dimensions.filter((d) => d.dimension !== 'brand_voice');
    const r = combineReview(base({ ai }));
    expect(r.status).toBe('review_required');
    expect(r.humanReviewReasons.join(' ')).toMatch(/did not score brand voice/);
  });
});

describe('issues are identifiable and honest', () => {
  it('keeps a quote only when those words are really in the piece', () => {
    const ai = allScores(5, { cta: 3 });
    ai.issues = [
      {
        dimension: 'cta',
        severity: 'major',
        problem: 'CTA has no link',
        quote: 'Friday’s tasting, 6pm',
        fix: 'Add where to book.',
      },
      {
        dimension: 'clarity',
        severity: 'minor',
        problem: 'Made up',
        quote: 'words that are not there',
        fix: null,
      },
    ];
    const r = combineReview(base({ ai }));
    expect(r.issues.find((i) => i.dimension === 'cta')!.quote).toBe(
      'Friday’s tasting, 6pm',
    );
    expect(r.issues.find((i) => i.dimension === 'clarity')!.quote).toBeNull();
  });

  it('a reviewer blocker fails a non-critical dimension even if it scored it well', () => {
    const ai = allScores(5);
    ai.issues = [
      {
        dimension: 'relevance',
        severity: 'blocker',
        problem: 'About a different product entirely.',
      },
    ];
    const r = combineReview(base({ ai }));
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual(['relevance']);
  });

  it('issues are ordered blockers first', () => {
    const ai = allScores(5, { clarity: 3 });
    ai.issues = [
      { dimension: 'clarity', severity: 'minor', problem: 'A bit long.' },
    ];
    const r = combineReview(
      base({
        ai,
        rules: [
          { code: 'no-cta', severity: 'block', message: 'No call to action.' },
        ],
      }),
    );
    expect(r.issues.map((i) => i.severity)).toEqual(['blocker', 'minor']);
  });

  it('feedback for a regeneration lists the real problems', () => {
    const ai = allScores(5, { cta: 2 });
    ai.issues = [
      {
        dimension: 'cta',
        severity: 'major',
        problem: 'CTA is vague',
        quote: 'Come taste',
        fix: 'Say where to book.',
      },
    ];
    const fb = reviewAsFeedback(combineReview(base({ ai })));
    expect(fb).toMatch(
      /\[Call to action\] CTA is vague \(“Come taste”\) — Say where to book\./,
    );
  });
});

describe('staleness', () => {
  it('the same body hashes the same, whatever its key order; a change does not', () => {
    expect(bodyHash({ a: 1, b: [1, 2] })).toBe(bodyHash({ b: [1, 2], a: 1 }));
    expect(bodyHash({ caption: 'x' })).not.toBe(bodyHash({ caption: 'y' }));
  });

  it('a review is current only for the body it reviewed', () => {
    const body = { caption: TEXT, cta: 'Book now' };
    const r = combineReview(base({ bodyHash: bodyHash(body) }));
    expect(isReviewCurrent(r, body)).toBe(true);
    expect(isReviewCurrent(r, { ...body, cta: 'Book today' })).toBe(false);
    expect(isReviewCurrent(null, body)).toBe(false);
  });
});

describe('the reviewer prompt', () => {
  const input: ReviewerInput = {
    format: 'Single image post',
    channel: 'Instagram',
    text: TEXT,
    cta: 'Book your seat',
    hashtags: ['#bourbon'],
    limits: { maxChars: 2200, idealMaxChars: 1200 },
    business: {
      name: 'Oak & Barrel',
      industry: 'Liquor store',
      description: 'Independent bottle shop',
      offerings: null,
    },
    audience: 'Local spirits enthusiasts',
    goal: 'Fill Friday tastings',
    brandVoice: {
      summary: 'Warm, knowledgeable',
      tone: ['warm'],
      phrases: [],
      avoid: ['discounts'],
    },
    recommendation: {
      title: 'Respond to the bourbon price cut',
      action: 'Post about curation',
      keyMessage: 'Compete on curation, not price',
      reason: 'A competitor cut prices',
      expectedOutcome: 'More tasting sign-ups',
      ctaExpected: true,
      ctaGuidance: 'Book a seat',
      ctaDestination: 'oakandbarrel.example/tastings',
      evidence: ['Competitor price cut — 3 days ago'],
    },
    request: null,
    facts: '',
    alcohol: true,
    source: null,
  };

  it('asks about every dimension, with what the piece was for — and never for a rewrite', () => {
    const p = buildReviewerPrompt(input);
    for (const d of REVIEW_DIMENSIONS) expect(p).toContain(`- ${d}:`);
    expect(p).toContain('Key message: Compete on curation, not price');
    expect(p).toContain('Never mentions: discounts');
    expect(p).toContain('ALCOHOL BUSINESS');
    expect(p).toContain(TEXT);
    expect(p).not.toMatch(/rewrite it|return the (fixed|revised)/i);
  });

  it('shows the source material, so fidelity to it can be judged at all', () => {
    const p = buildReviewerPrompt({
      ...input,
      source: {
        material: 'Rival chain cuts bourbon prices by 15% across 40 stores.',
        posture: 'clear',
        concerns: [],
      },
    });
    expect(p).toContain('SOURCE MATERIAL THIS PIECE WAS WRITTEN FROM');
    expect(p).toContain('cuts bourbon prices by 15%');
    // No warning on ordinary material — the reviewer must not be primed to
    // treat a competitor's price cut as a tragedy.
    expect(p).not.toContain('WARNING');
  });

  it('warns about an unsafe source before showing it, and calls promotion a blocker', () => {
    const p = buildReviewerPrompt({
      ...input,
      source: {
        material: 'Three people died in a crash outside the distillery.',
        posture: 'unsuitable',
        concerns: ['deaths or fatalities'],
      },
    });
    expect(p).toContain('WARNING');
    expect(p).toContain('DEATHS OR FATALITIES');
    // The warning precedes the material it is about.
    expect(p.indexOf('WARNING')).toBeLessThan(
      p.indexOf('SOURCE MATERIAL THIS PIECE WAS WRITTEN FROM'),
    );
  });

  it('has no source block when the piece was written from nothing recorded', () => {
    expect(buildReviewerPrompt(input)).not.toContain('SOURCE MATERIAL');
  });
});
