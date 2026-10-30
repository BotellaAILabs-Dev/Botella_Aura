import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { classifySource, signalPosture } from '@/lib/brand-safety';
import { selectSignalsForAi } from '@/lib/ai-opportunity-detection';
import { detectOpportunities, type DetectableSignal } from '@/lib/opportunity-detection';
import { validateRecommendation, type QualityInput } from '@/lib/recommendation-quality';
import { normalizeTrends } from '@/server/signals/normalize';

/**
 * The MOM risk: a news story about real harm must never become an Aura
 * suggestion to market off it. Checked at every stage — when the story is
 * collected, when opportunities are found, and right before a suggestion is
 * shown (for anything stored before this check existed).
 */

const NOW = new Date('2026-10-30T12:00:00Z');
const DEATHS = 'Three people died after drinking counterfeit whisky at a wedding';
const SAFE_1 = 'Single malt whisky exports reach a record high this year';
const SAFE_2 = 'Distillers report strong demand for aged whisky in Asia';
const CAUTION = 'Whisky makers face a lawsuit over labelling rules in EU courts';

let n = 0;
const story = (title: string, o: Partial<DetectableSignal> = {}): DetectableSignal => ({
  id: `s${++n}`,
  source: 'TRENDS',
  kind: 'TREND_ITEM',
  title,
  summary: title,
  url: null,
  refId: `r${n}`,
  observedAt: new Date(NOW.getTime() - 86_400_000),
  expiresAt: new Date(NOW.getTime() + 10 * 86_400_000),
  reliability: 'MEDIUM',
  occurrences: 1,
  contextMatches: ['keyword:whisky'],
  metadata: {},
  dedupeKey: `k${n}`,
  ...o,
});

describe('the headlines used here', () => {
  it('are classified as expected', () => {
    expect(classifySource(DEATHS).posture).toBe('unsuitable');
    expect(classifySource(SAFE_1).posture).toBe('clear');
    expect(classifySource(CAUTION).posture).toBe('caution');
  });
});

describe('collecting: trend signals keep their safety verdict', () => {
  it('uses the verdict stored on the digest item, or works it out', () => {
    const [stored, computed] = normalizeTrends([
      {
        id: 'd1',
        date: NOW,
        payload: {
          items: [
            { id: 'i1', title: 'A calm headline about whisky', source: 'news', url: 'https://x.example/1', safety: { posture: 'unsuitable', concerns: ['deaths or fatalities'] } },
            { id: 'i2', title: DEATHS, source: 'news', url: 'https://x.example/2' },
          ],
        },
      },
    ]);
    expect((stored!.metadata as { safety: { posture: string } }).safety.posture).toBe('unsuitable');
    expect((computed!.metadata as { safety: { posture: string } }).safety.posture).toBe('unsuitable');
  });

  it('reads the business’s own signals as clear', () => {
    expect(signalPosture({ source: 'ANALYTICS', title: 'Posts about funerals died down', summary: 'x', metadata: {} })).toBe('clear');
  });
});

describe('detecting: a story about real harm is never evidence', () => {
  it('does not propose an opportunity built on news about deaths', () => {
    const r = detectOpportunities([story(DEATHS), story(SAFE_1)], null, { now: NOW });
    expect(r.accepted.filter((a) => a.type === 'TRENDING_TOPIC')).toEqual([]);
    expect(r.sensitive).toEqual([DEATHS]);
  });

  it('still finds the opportunity in the safe coverage', () => {
    const r = detectOpportunities([story(DEATHS), story(SAFE_1), story(SAFE_2)], null, { now: NOW });
    const topic = r.accepted.find((a) => a.type === 'TRENDING_TOPIC')!;
    expect(topic.signals.map((s) => s.title).sort()).toEqual([SAFE_1, SAFE_2].sort());
  });

  it('marks an opportunity whose coverage is sensitive but usable', () => {
    const r = detectOpportunities([story(CAUTION), story(SAFE_1)], null, { now: NOW });
    expect(r.accepted[0]!.criteria.join(' ')).toMatch(/sensitive subject/);
  });

  it('never hands the AI a story about real harm to find an angle in', () => {
    const picked = selectSignalsForAi([story(DEATHS), story(SAFE_1)], { now: NOW });
    expect(picked.map((s) => s.title)).toEqual([SAFE_1]);
  });
});

describe('showing: suggestions built on sensitive news', () => {
  const rec = (evidenceTitle: string, source = 'TRENDS'): QualityInput => ({
    rec: {
      id: 'r1',
      type: 'CONTENT',
      status: 'PRESENTED',
      title: 'Join the conversation on whisky',
      summary: 'Whisky is in the news.',
      action: 'Publish a LinkedIn post with your view on the story.',
      steps: ['Draft the post'],
      rationale: 'Several stories cover whisky this week.',
      expectedOutcome: 'More comments from whisky buyers.',
      outcomeMetric: null,
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: null,
      details: {},
      confidence: 'MEDIUM',
      blockers: [],
    },
    evidence: [
      { label: evidenceTitle, detail: evidenceTitle, url: null, refId: 'x', signalId: 's1', opportunitySignalId: 'o1', source, reliability: 'MEDIUM', current: true },
    ],
    opportunity: { id: 'opp', status: 'RECOMMENDED', title: 't', summary: evidenceTitle, rationale: null, signalIds: ['s1'], evidenceIds: ['o1'] },
    business: { name: 'Distillery', description: 'We distil single malt whisky.', offerings: null, goals: null, audience: null, channels: ['LinkedIn'], avoid: [], competitors: [] },
    now: NOW,
  });
  const safety = (r: ReturnType<typeof validateRecommendation>) => r.checks.find((c) => c.check === 'brand_safety')!;

  it('holds back one built on news about deaths, saying why', () => {
    const r = validateRecommendation(rec(DEATHS));
    expect(safety(r).status).toBe('fail');
    expect(r.verdict).toBe('blocked');
    expect(r.problems.join(' ')).toMatch(/deaths/);
  });

  it('shows one built on sensitive-but-usable news, marked for care', () => {
    const r = validateRecommendation(rec(CAUTION));
    expect(safety(r).status).toBe('warn');
    expect(r.verdict).not.toBe('blocked');
  });

  it('does not judge the business’s own material as news', () => {
    expect(safety(validateRecommendation(rec(DEATHS, 'ANALYTICS'))).status).toBe('pass');
  });
});
