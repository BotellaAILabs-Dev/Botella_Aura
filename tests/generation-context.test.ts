import { describe, it, expect } from 'vitest';

import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import { buildContentBrief } from '@/lib/content-brief';
import {
  assembleGenerationContext,
  CONTEXT_TOKEN_BUDGET,
  domainOf,
  generationContextRecord,
  generationContextToPrompt,
  redactSensitive,
  SECTION_SPECS,
  type AssembleInput,
} from '@/lib/generation-context';
import { buildContextHandoff } from '@/lib/recommendation-context-handoff';

/**
 * The package the generation model receives: business-specific, current,
 * relevant, free of sensitive data, within budget, and traceable to the
 * recommendation.
 */

const NOW = new Date('2026-10-09T12:00:00Z');

const SNAPSHOT = {
  version: 2,
  companyId: 'co1',
  fingerprint: 'abcdef1234567890',
  revision: '2026-10-09T10:00:00.000Z',
  generatedAt: '2026-10-09T11:00:00.000Z',
  view: 'content',
  strict: false,
  business: {
    name: 'Roastery',
    description:
      'We roast single-origin coffee in small batches and sell subscriptions online.',
    industry: 'Coffee',
    website: 'https://www.roastery.example',
  },
  products: {
    offerings: 'Coffee subscriptions, single-origin beans',
    highlights: [
      {
        title: 'Our sourcing',
        category: null,
        excerpt:
          'We buy directly from farms in Ethiopia and pay above fair-trade prices for coffee.',
      },
      {
        title: 'Shipping policy',
        category: null,
        excerpt: 'Orders ship within two days.',
      },
    ],
  },
  audience: {
    marketMode: 'B2C',
    description: 'Home brewers who buy beans online',
    roles: [],
    industries: [],
    stages: [],
  },
  goals: {
    current: 'Grow coffee subscriptions',
    campaigns: [
      {
        name: 'Autumn espresso',
        goal: 'Sell espresso blends',
        audience: null,
        themes: ['espresso'],
      },
      {
        name: 'Coffee prices explained',
        goal: 'Explain pricing',
        audience: null,
        themes: ['prices', 'coffee'],
      },
    ],
  },
  voice: {
    summary: 'Warm and plain-spoken.',
    tone: ['warm'],
    avoid: ['caffeine health claims'],
    vocabulary: [],
    emoji: 'rare',
    hashtags: 'few',
    notes: null,
  },
  channels: { publishesOn: ['LinkedIn'], connected: ['LinkedIn'] },
  learning: {
    insights: [
      {
        type: 'CONTENT_FORMAT',
        insight: 'Carousels on LinkedIn get twice the saves',
        confidence: 'HIGH',
        sampleSize: 12,
        confirmedByUser: false,
        capturedAt: null,
      },
      {
        type: 'TOPIC',
        insight: 'Posts about gardening tips underperform',
        confidence: 'HIGH',
        sampleSize: 8,
        confirmedByUser: false,
        capturedAt: null,
      },
    ],
  },
  market: null,
  history: {
    recentTopics: ['Meet our roaster'],
    performance: { period: 'last 7 days', metrics: { totalEngagement: 300 } },
  },
  trust: {},
  assumptions: [
    {
      field: 'audience.roleTitles',
      label: 'Buyer roles',
      value: 'Baristas',
      reason: 'inferred from the website',
    },
  ],
  omitted: [],
  gaps: [],
  meta: { sections: ['business'], estimatedTokens: 400 },
} as unknown as BusinessContextSnapshot;

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    brief:
      'A post on why specialty coffee prices are rising and what it means for subscribers.',
    contentBrief: null,
    snapshot: SNAPSHOT,
    snapshotStatus: 'current',
    playbook: {
      label: 'LinkedIn post',
      rules: ['Lead with a hook.', 'Keep it under 1,300 characters.'],
    },
    format: { type: 'LINKEDIN_POST', channel: 'LinkedIn' },
    campaign: null,
    knowledge: [
      {
        id: 'k1',
        title: 'Coffee pricing',
        content: 'Green coffee prices rose 30% this year as harvests shrank.',
        score: 2.1,
      },
      {
        id: 'k2',
        title: 'Office party',
        content: 'The staff party is on Friday.',
        score: 0,
      },
    ],
    reference: [],
    previous: [
      {
        id: 'p1',
        title: 'Why coffee prices change',
        excerpt: 'Coffee prices follow harvests and shipping costs.',
        channel: 'LinkedIn',
        at: '2026-09-20T00:00:00Z',
      },
      {
        id: 'p2',
        title: 'Meet our roaster',
        excerpt: 'Say hello to Sam, our head roaster.',
        channel: 'LinkedIn',
        at: '2026-09-25T00:00:00Z',
      },
    ],
    now: NOW,
    ...over,
  };
}

const section = (
  c: ReturnType<typeof assembleGenerationContext>,
  key: string,
) => c.sections.find((s) => s.key === key);

describe('generation receives relevant business context', () => {
  const c = assembleGenerationContext(input());

  it('the business, the format and the brief — always', () => {
    for (const key of ['brief', 'business', 'channel'])
      expect(section(c, key), key).toBeDefined();
    expect(section(c, 'business')!.text).toMatch(/single-origin coffee/);
    expect(section(c, 'business')!.text).toMatch(
      /What it sells: Coffee subscriptions/,
    );
    expect(section(c, 'channel')!.text).toMatch(/Lead with a hook/);
  });

  it('goal, audience and voice from the current snapshot', () => {
    expect(section(c, 'goal')!.text).toMatch(/Grow coffee subscriptions/);
    expect(section(c, 'audience')!.text).toMatch(/Home brewers/);
    expect(section(c, 'voice')!.text).toMatch(
      /Never mention: caffeine health claims/,
    );
  });

  it('only the product highlights that match the topic', () => {
    expect(section(c, 'business')!.text).toMatch(/Our sourcing/);
    expect(section(c, 'business')!.text).not.toMatch(/Shipping policy/);
  });

  it('assumptions are marked as unconfirmed, never as fact', () => {
    expect(section(c, 'assumptions')!.text).toMatch(/Baristas/);
    expect(SECTION_SPECS.assumptions.title).toMatch(/NOT CONFIRMED/);
  });
});

describe('irrelevant context is removed, and says why', () => {
  const c = assembleGenerationContext(input());

  it('knowledge that does not match the topic', () => {
    expect(section(c, 'knowledge')!.text).toMatch(/rose 30%/);
    expect(section(c, 'knowledge')!.text).not.toMatch(/staff party/);
    expect(c.dropped).toContainEqual({
      key: 'knowledge',
      reason: '1 passage that did not match this topic.',
    });
    expect(c.trace.knowledgeChunkIds).toEqual(['k1']);
  });

  it('a passage retrieval matched only by part of a word ("not" in "notes") is still left out', () => {
    const c = assembleGenerationContext(
      input({
        brief: 'Do not mirror Acme’s wording on coffee prices.',
        knowledge: [
          {
            id: 'k1',
            title: 'Office notes',
            content: 'The staff party is on Friday.',
            score: 0.4,
          },
          {
            id: 'k2',
            title: 'Pricing',
            content: 'Our coffee price went up in spring.',
            score: 0.6,
          },
        ],
      }),
    );
    expect(c.trace.knowledgeChunkIds).toEqual(['k2']); // "price" matches "prices"
  });

  it('earlier posts on other topics — the related one is kept', () => {
    expect(section(c, 'previousContent')!.text).toMatch(
      /Why coffee prices change/,
    );
    expect(section(c, 'previousContent')!.text).not.toMatch(/Meet our roaster/);
    expect(c.trace.previousContentIds).toEqual(['p1']);
  });

  it('campaigns this piece is not for; a related one is kept', () => {
    expect(section(c, 'goal')!.text).toMatch(/Coffee prices explained/);
    expect(section(c, 'goal')!.text).not.toMatch(/Autumn espresso/);
    expect(
      c.dropped.some(
        (d) => d.key === 'goal' && /1 running campaign/.test(d.reason),
      ),
    ).toBe(true);
  });

  it('learned patterns about other topics', () => {
    expect(section(c, 'memory')?.text ?? '').not.toMatch(/gardening/);
    expect(c.dropped.some((d) => d.key === 'memory')).toBe(true);
  });

  it('performance numbers are never sent', () => {
    expect(generationContextToPrompt(c)).not.toMatch(
      /totalEngagement|last 7 days/,
    );
    expect(c.dropped.some((d) => d.key === 'performance')).toBe(true);
  });

  it('the campaign the piece is for is always included, even if not running', () => {
    const own = assembleGenerationContext(
      input({
        campaign: {
          id: 'cam1',
          name: 'Holiday gifts',
          goal: 'Sell gift boxes',
          audience: 'Gift buyers',
          themes: ['gifts'],
        },
      }),
    );
    expect(section(own, 'goal')!.text).toMatch(
      /This piece is for the campaign “Holiday gifts” — Sell gift boxes \(for Gift buyers\)/,
    );
    expect(own.trace.campaignId).toBe('cam1');
  });
});

describe('sensitive or unnecessary information is not passed to the model', () => {
  it('redacts personal data in documents, pages and earlier posts — but keeps the business’s own address', () => {
    const c = assembleGenerationContext(
      input({
        knowledge: [
          {
            id: 'k1',
            title: 'Coffee pricing',
            content:
              'Coffee prices rose. Supplier contact: jane.doe@gmail.com, +44 20 7946 0958. Press: hello@roastery.example. Founded 2014, beans from $18.50.',
            score: 2,
          },
        ],
      }),
    );
    const t = section(c, 'knowledge')!.text;
    expect(t).not.toMatch(/jane\.doe@gmail\.com/);
    expect(t).not.toMatch(/7946/);
    expect(t).toMatch(/hello@roastery\.example/);
    expect(t).toMatch(/2014/);
    expect(t).toMatch(/\$18\.50/);
    expect(c.redactions).toEqual({ email: 1, phone: 1 });
  });

  it('removes keys, tokens, passwords and connection strings everywhere — even the person’s brief', () => {
    const c = assembleGenerationContext(
      input({
        brief:
          'Post about coffee prices. (internal: api_key=AIzaSyA1234567890abcdefghijklmnopqrstu and postgres://admin:hunter2@db.example/prod)',
      }),
    );
    const t = section(c, 'brief')!.text;
    expect(t).not.toMatch(/AIza|hunter2|postgres:\/\//);
    expect(t).toMatch(/Post about coffee prices/);
    expect(c.redactions.secret).toBeGreaterThanOrEqual(2);
  });

  it('a key inside `name = value` is removed once, cleanly', () => {
    const r = redactSensitive(
      'Internal: api_key=sk-ant-abcdefghijklmnopqrstuvwxyz123456.',
      { personal: false },
    );
    expect(r.text).toBe('Internal: [secret removed].');
    expect(r.found.secret).toBe(1);
  });

  it('a passage sharing a single, chance word with the brief is left out', () => {
    const c = assembleGenerationContext(
      input({
        brief: 'Internal note: a post about coffee prices.',
        knowledge: [
          {
            id: 'k1',
            title: 'Office notes',
            content: 'The staff party is on Friday.',
            score: 0.3,
          },
        ],
      }),
    );
    expect(c.trace.knowledgeChunkIds).toEqual([]);
  });

  it('card numbers (valid ones only), signed URLs and internal record ids', () => {
    const r = redactSensitive(
      'Card 4111 1111 1111 1111; order 1234567890123; https://x.example/file?token=abc123&size=2; rec cm1abcdefghijklmnopqrstuv',
      { personal: false },
    );
    expect(r.text).toMatch(/\[card number removed\]/);
    expect(r.text).toMatch(/order 1234567890123/); // not a valid card
    expect(r.text).toMatch(/token=\[removed\]&size=2/);
    expect(r.text).toMatch(/rec \[id\]/);
  });

  it('a phone-looking range or a year is not a phone number', () => {
    const r = redactSensitive('Open 2020-2026, call volumes up 12.5%.', {
      personal: true,
    });
    expect(r.text).toBe('Open 2020-2026, call volumes up 12.5%.');
  });

  it('reads the business’s own domain from its website', () => {
    expect(domainOf('https://www.roastery.example/about')).toBe(
      'roastery.example',
    );
    expect(domainOf('roastery.example')).toBe('roastery.example');
    expect(domainOf(null)).toBeNull();
  });
});

describe('context-size management', () => {
  it('stays within the budget by default', () => {
    const c = assembleGenerationContext(input());
    expect(c.budget.maxTokens).toBe(CONTEXT_TOKEN_BUDGET);
    expect(c.budget.usedTokens).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
  });

  it('a tight budget drops optional sections in priority order — never a required one', () => {
    const big = 'Coffee prices and harvests. '.repeat(400);
    const c = assembleGenerationContext(
      input({
        budgetTokens: 700,
        knowledge: [{ id: 'k1', title: 'Coffee', content: big, score: 3 }],
        reference: [{ url: 'https://news.example/coffee', text: big }],
      }),
    );
    for (const key of ['brief', 'business', 'channel'])
      expect(section(c, key), key).toBeDefined();
    expect(c.dropped.some((d) => d.reason === 'Over the context budget.')).toBe(
      true,
    );
    // Lower-priority sections go first.
    const kept = c.sections.map((s) => SECTION_SPECS[s.key].priority);
    const droppedP = c.dropped
      .filter((d) => d.reason === 'Over the context budget.')
      .map((d) => SECTION_SPECS[d.key as keyof typeof SECTION_SPECS].priority);
    expect(Math.min(...droppedP)).toBeGreaterThan(
      Math.max(...kept.filter((p) => p <= 2)),
    );
  });

  it('every section is capped, and says when it was trimmed', () => {
    const c = assembleGenerationContext(
      input({
        knowledge: Array.from({ length: 8 }, (_, i) => ({
          id: `k${i}`,
          title: 'Coffee',
          content: 'Coffee prices rose. '.repeat(60),
          score: 3,
        })),
      }),
    );
    const k = section(c, 'knowledge')!;
    expect(k.tokens).toBeLessThanOrEqual(SECTION_SPECS.knowledge.maxTokens + 2);
    expect(k.trimmed).toBe(true);
  });
});

describe('traceable to the recommendation, from current context', () => {
  const handoff = buildContextHandoff({
    recommendation: {
      id: 'rec1',
      opportunityId: 'opp1',
      status: 'ACCEPTED',
      type: 'CONTENT',
      title: 'Explain the coffee price rise',
      action: 'Publish a post on LinkedIn about rising coffee prices.',
      steps: ['Say what changed at origin'],
      rationale: 'Two news sources report coffee prices climbing.',
      expectedOutcome: 'Subscribers understand the price change.',
      outcomeMetric: null,
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: 'Current subscribers',
      details: { action: 'post', angle: 'Honest about prices' },
      confidence: 'MEDIUM',
      confidenceReason: null,
      executable: true,
      blockers: [],
      evidence: [
        {
          label: 'Coffee prices climb as harvests shrink',
          detail: '',
          url: 'https://a.example/1',
          observedAt: null,
        },
      ],
    },
    business: {
      name: 'Roastery',
      description: 'Small-batch roaster.',
      offerings: null,
      industry: null,
      website: 'https://roastery.example',
      goals: null,
      audience: null,
      campaigns: [],
      connected: ['LinkedIn'],
      voice: null,
      memory: [],
    },
    now: NOW,
  });
  const brief = buildContentBrief({
    handoff,
    opportunity: {
      id: 'opp1',
      title: 'Coffee prices are rising',
      type: 'TRENDING_TOPIC',
      typeLabel: 'Trending topic',
      summary: 'Several outlets cover rising prices.',
      angle: null,
    },
  });
  const c = assembleGenerationContext(input({ contentBrief: brief }));

  it('carries the recommendation, its opportunity and evidence', () => {
    expect(section(c, 'recommendation')!.text).toMatch(
      /Key message: Honest about prices/,
    );
    expect(section(c, 'recommendation')!.text).toMatch(
      /cite only this.*Coffee prices climb/,
    );
    expect(section(c, 'opportunity')!.text).toMatch(
      /Coffee prices are rising \(Trending topic\)/,
    );
  });

  it('the brief’s audience wins over the snapshot’s, and says where it came from', () => {
    expect(section(c, 'audience')!.text).toBe('Current subscribers');
    expect(section(c, 'audience')!.from).toBe('content_brief:recommendation');
  });

  it('the trace names the recommendation, opportunity, brief version and snapshot', () => {
    expect(c.trace).toMatchObject({
      recommendationId: 'rec1',
      opportunityId: 'opp1',
      contentBriefVersion: 1,
      snapshot: {
        fingerprint: 'abcdef1234567890',
        revision: '2026-10-09T10:00:00.000Z',
        status: 'current',
      },
    });
  });

  it('without a recommendation, says so', () => {
    const plain = assembleGenerationContext(input());
    expect(plain.trace.recommendationId).toBeNull();
    expect(plain.dropped).toContainEqual({
      key: 'recommendation',
      reason: 'Not written for a recommendation.',
    });
  });

  it('the draft keeps the trace and the package’s shape — not its text', () => {
    const rec = generationContextRecord(c);
    expect(rec.trace.recommendationId).toBe('rec1');
    expect(rec.sections.every((s) => !('text' in s))).toBe(true);
    expect(JSON.stringify(rec)).not.toMatch(/single-origin/);
  });

  it('the model reads it with the snapshot it came from', () => {
    expect(generationContextToPrompt(c)).toMatch(
      /current business snapshot abcdef12/,
    );
    expect(generationContextToPrompt(c)).toMatch(
      /## WRITTEN FOR AURA’S RECOMMENDATION/,
    );
  });
});
