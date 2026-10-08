import { describe, it, expect } from 'vitest';

import {
  QUALITY_CHECKS,
  heldBackReason,
  validateRecommendation,
  type QualityInput,
} from '@/lib/recommendation-quality';
import { LOW_CONFIDENCE_BLOCKER } from '@/lib/recommendation-rules';

/**
 * Recommendation quality: checked before presentation. Unsupported,
 * hallucinated or contradicted recommendations are never shown as trusted.
 */

const NOW = new Date('2026-10-08T12:00:00Z');

function good(): QualityInput {
  return {
    rec: {
      id: 'rec1',
      type: 'COMPETITIVE_RESPONSE',
      status: 'PRESENTED',
      title: 'Respond to Acme Coffee’s pricing change',
      summary: 'Acme Coffee cut its subscription price by 20%.',
      action:
        'Publish a post on LinkedIn giving your own view on this — do not mirror Acme Coffee’s wording.',
      steps: ['Draft the post', 'Lead with freshness'],
      rationale:
        'Acme Coffee cut subscriptions by 20%, seen directly on its site.',
      expectedOutcome:
        'Buyers comparing options hear your position, not only the competitor’s.',
      outcomeMetric: null,
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: 'Home brewers',
      details: { action: 'response-post', competitor: 'Acme Coffee' },
      confidence: 'MEDIUM',
      blockers: [],
    },
    evidence: [
      {
        label: 'Acme Coffee changed its pricing',
        detail: 'Cut subscriptions by 20%',
        url: 'https://acme.example/pricing',
        refId: 'snap1',
        signalId: 'sig1',
        opportunitySignalId: 'os1',
        source: 'COMPETITORS',
        reliability: 'HIGH',
        current: true,
      },
    ],
    opportunity: {
      id: 'opp1',
      status: 'RECOMMENDED',
      title: 'Respond to Acme Coffee’s pricing change',
      summary: 'Acme Coffee cut its subscription price.',
      rationale: 'A pricing change buyers will notice.',
      signalIds: ['sig1'],
      evidenceIds: ['os1'],
    },
    business: {
      name: 'Roastery',
      description: 'We roast single-origin coffee in small batches.',
      offerings: 'Coffee subscriptions',
      goals: 'Grow coffee subscriptions',
      audience: 'Home brewers',
      channels: ['LinkedIn', 'Instagram'],
      avoid: ['price wars'],
      competitors: ['Acme Coffee'],
    },
    now: NOW,
  };
}
type Patch = {
  rec?: Partial<QualityInput['rec']>;
  evidence?: QualityInput['evidence'];
  opportunity?:
    | QualityInput['opportunity']
    | Partial<NonNullable<QualityInput['opportunity']>>;
  business?: Partial<QualityInput['business']>;
};
function check(patch: Patch = {}) {
  const g = good();
  return validateRecommendation({
    ...g,
    rec: { ...g.rec, ...patch.rec },
    evidence: patch.evidence ?? g.evidence,
    opportunity:
      patch.opportunity === null
        ? null
        : { ...g.opportunity!, ...(patch.opportunity ?? {}) },
    business: { ...g.business, ...patch.business },
  });
}
const status = (r: ReturnType<typeof check>, c: string) =>
  r.checks.find((x) => x.check === c)!.status;

describe('a well-supported recommendation', () => {
  it('passes every check and is trusted', () => {
    const r = check();
    expect(r.verdict).toBe('trusted');
    expect(r.checks.map((c) => c.check)).toEqual([...QUALITY_CHECKS]);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('hallucinated or unsupported — blocked, never shown', () => {
  it('an invented statistic no evidence or profile contains', () => {
    const r = check({
      rec: { expectedOutcome: 'Boost subscriptions by 300% within a month.' },
    });
    expect(r.verdict).toBe('blocked');
    expect(status(r, 'business_context')).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/300%.*none of its evidence/);
  });

  it('an invented figure in the reasoning', () => {
    const r = check({
      rec: { rationale: 'Acme lost 4,500 customers last quarter.' },
    });
    expect(r.verdict).toBe('blocked');
    expect(r.problems.join(' ')).toMatch(/4,500/);
  });

  it('a competitor the business does not track and no evidence mentions', () => {
    const r = check({
      rec: {
        details: { action: 'response-post', competitor: 'MegaBrew Corp' },
      },
    });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain(
      'names MegaBrew Corp, a competitor the business does not track',
    );
  });

  it('a topic the business has said it avoids', () => {
    const r = check({
      rec: {
        action:
          'Publish a post on LinkedIn starting a price wars campaign against Acme Coffee.',
      },
    });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain(
      'mentions “price wars”, a topic the business avoids',
    );
  });

  it('no evidence at all', () => {
    const r = check({ evidence: [] });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain('it has no evidence');
  });

  it('evidence that cannot be traced to any signal or source', () => {
    const r = check({
      evidence: [
        {
          ...good().evidence[0]!,
          url: null,
          refId: null,
          signalId: null,
          opportunitySignalId: null,
        },
      ],
    });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain(
      'none of its evidence can be traced to a signal or a source',
    );
  });

  it('not linked to any opportunity of this business', () => {
    const r = check({ opportunity: null });
    expect(r.verdict).toBe('blocked');
    expect(status(r, 'opportunity')).toBe('fail');
  });

  it('its opportunity was already turned down or expired', () => {
    for (const s of ['REJECTED', 'EXPIRED']) {
      const r = check({ opportunity: { status: s } });
      expect(r.verdict).toBe('blocked');
      expect(r.problems.join(' ')).toMatch(/already answered it/);
    }
  });

  it('a channel Aura does not support', () => {
    const r = check({ rec: { channel: 'TikTok' } });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain('TikTok is not a channel Aura supports');
  });

  it('content with nowhere to publish', () => {
    const r = check({ rec: { channel: null } });
    expect(r.verdict).toBe('blocked');
    expect(r.problems).toContain(
      'it asks for content but names nowhere to publish it',
    );
  });

  it('a promised result', () => {
    for (const expectedOutcome of [
      'Guaranteed to double your subscriptions.',
      'This post will go viral among home brewers.',
      'Sales will skyrocket this week.',
    ]) {
      const r = check({ rec: { expectedOutcome } });
      expect(r.verdict).toBe('blocked');
      expect(r.problems).toContain('it promises a result no one can guarantee');
    }
  });

  it('no real action or outcome', () => {
    expect(check({ rec: { action: 'Do it.' } }).problems).toContain(
      'it does not say what to do',
    );
    expect(check({ rec: { expectedOutcome: 'Good.' } }).problems).toContain(
      'it does not say what it should achieve',
    );
  });

  it('output outside the defined schema', () => {
    const r = check({
      rec: { title: '', steps: Array.from({ length: 12 }, () => 'step') },
    });
    expect(r.verdict).toBe('blocked');
    expect(status(r, 'schema')).toBe('fail');
  });

  it('a business Aura knows nothing about', () => {
    const r = check({ business: { description: null, offerings: null } });
    expect(r.verdict).toBe('blocked');
    expect(r.problems[0]).toMatch(/does not know what the business does/);
  });
});

describe('weak but not false — shown only as "needs review"', () => {
  it('low confidence', () => {
    const r = check({
      rec: { confidence: 'LOW', blockers: [LOW_CONFIDENCE_BLOCKER] },
    });
    expect(r.verdict).toBe('needs_review');
    expect(r.warnings).toContain('Aura is not confident in it');
  });

  it('high confidence on low-reliability evidence', () => {
    const r = check({
      rec: { confidence: 'HIGH' },
      evidence: [{ ...good().evidence[0]!, reliability: 'LOW' }],
    });
    expect(r.verdict).toBe('needs_review');
    expect(r.warnings.join(' ')).toMatch(/claims high confidence/);
  });

  it('evidence no longer current, or not enough of the right kind', () => {
    expect(
      check({ evidence: [{ ...good().evidence[0]!, current: false }] })
        .warnings,
    ).toContain('none of its evidence is current any more');
    const wrongKind = check({
      evidence: [{ ...good().evidence[0]!, source: 'TRENDS' }],
    });
    expect(wrongKind.verdict).toBe('needs_review');
    expect(wrongKind.warnings.join(' ')).toMatch(
      /needs one current signal from a tracked competitor/,
    );
  });

  it('evidence that did not come from its opportunity', () => {
    const r = check({
      opportunity: { signalIds: ['other'], evidenceIds: ['other'] },
    });
    expect(r.verdict).toBe('needs_review');
    expect(r.warnings).toContain(
      'none of its evidence comes from its opportunity',
    );
  });

  it('a vague action', () => {
    const r = check({
      rec: {
        action: 'Consider leveraging synergies across your social presence.',
      },
    });
    expect(r.verdict).toBe('needs_review');
    expect(status(r, 'actionability')).toBe('warn');
  });

  it('a generic or unmeasurable outcome', () => {
    expect(
      check({ rec: { expectedOutcome: 'Progress on this opportunity.' } })
        .warnings,
    ).toContain('its expected outcome is generic');
    expect(
      check({
        rec: { expectedOutcome: 'A nicer feeling about the brand overall.' },
      }).warnings,
    ).toContain('its expected outcome cannot be measured');
  });

  it('a channel the business has not said it uses', () => {
    const r = check({
      rec: { channel: 'Instagram' },
      business: { channels: ['LinkedIn'] },
    });
    expect(r.verdict).toBe('needs_review');
    expect(r.warnings).toContain(
      'the business has not said it publishes on Instagram',
    );
  });

  it('something blocking execution (beyond low confidence)', () => {
    const r = check({
      rec: { blockers: ['Aura cannot connect YouTube yet.'] },
    });
    expect(r.verdict).toBe('needs_review');
    expect(r.warnings).toContain('Aura cannot connect YouTube yet');
  });
});

describe('figures that are supported are fine', () => {
  it('a figure from the evidence or the profile is not "invented"', () => {
    expect(check({ rec: { title: 'Answer Acme’s 20% cut' } }).verdict).toBe(
      'trusted',
    );
  });

  it('an accepted recommendation stays valid when its opportunity was accepted with it', () => {
    expect(
      check({
        rec: { status: 'ACCEPTED' },
        opportunity: { status: 'ACCEPTED' },
      }).verdict,
    ).toBe('trusted');
  });

  it('schema problems are said in words, never as validator output', () => {
    const r = check({ rec: { title: '', channel: 'TikTok' } });
    expect(r.problems).toContain('its headline is empty');
    expect(r.problems).toContain('its channel is not one Aura recognises');
    expect(r.problems.join(' ')).not.toMatch(/enum|Expected|received|ZodError/);
  });

  it('a held-back reason reads as a sentence', () => {
    expect(heldBackReason(check({ rec: { channel: 'TikTok' } }))).toBe(
      'TikTok is not a channel Aura supports.',
    );
  });
});
