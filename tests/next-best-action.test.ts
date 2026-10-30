import { describe, expect, it } from 'vitest';

import type { SuggestionView } from '@/lib/aura-suggests';
import type { AttentionItem } from '@/lib/business-context-ui';
import { checkQuality, mentionsBusiness } from '@/lib/content-quality';
import { playbookFor } from '@/lib/content-playbook';
import type { MarketingGap } from '@/lib/marketing-gaps';
import { buildNextActions, dedupeSuggestions, sameSubject, type NextActionInput } from '@/lib/next-best-action';

/**
 * Next best action: one ranked list, problem → why → what to do, with the
 * same thing never shown twice; and content that is specific to the business.
 */

const suggestion = (id: string, o: Partial<SuggestionView> = {}): SuggestionView =>
  ({
    id,
    status: 'PRESENTED',
    stage: 'open',
    what: `Suggestion ${id}`,
    action: `Do thing ${id}`,
    steps: [],
    why: 'Because the evidence says so. More detail follows here.',
    whyNow: [],
    expectedOutcome: 'More replies.',
    basedOn: [],
    evidence: [],
    confidence: 'Fairly sure',
    timing: null,
    place: 'Up next',
    rank: 1,
    resurfaced: false,
    channel: 'LinkedIn',
    caution: null,
    next: { label: 'Write it', href: `/dashboard/content/new?rec=${id}`, accepts: true, blocked: null, module: 'content', moduleLabel: 'Content Studio', related: [] },
    ...o,
  }) as SuggestionView;

const gap = (o: Partial<MarketingGap> = {}): MarketingGap => ({
  key: 'channel_silent:Instagram',
  kind: 'channel_silent',
  severity: 'medium',
  title: 'Nothing on Instagram in 6 weeks.',
  evidence: 'Last Instagram post: “Autumn blend” on 2026-09-18.',
  action: { label: 'Write a Instagram post', brief: 'An Instagram post on what’s new with us this month', type: 'IMAGE_POST' },
  ...o,
});

const missing: AttentionItem = {
  key: 'missing:identity.description',
  severity: 'required',
  title: 'What the business does is missing',
  detail: 'Aura needs this before it can write or recommend anything specific to you.',
  editKey: 'identity.description',
};

const input = (o: Partial<NextActionInput> = {}): NextActionInput => ({
  attention: [],
  pendingApproval: 0,
  suggestions: [],
  gaps: [],
  canApprove: true,
  ...o,
});

describe('buildNextActions', () => {
  it('puts what stops Aura working first, then work waiting on the person', () => {
    const list = buildNextActions(
      input({ attention: [missing], pendingApproval: 2, suggestions: [suggestion('a', { place: 'Top pick' })], gaps: [gap()] }),
    );
    expect(list.map((a) => a.source)).toEqual(['setup', 'approval', 'suggestion', 'gap']);
    expect(list[0]!.action.href).toBe('/dashboard/business#field-identity.description');
    expect(list[1]!.problem).toBe('2 drafts are waiting for approval.');
  });

  it('gives every action a problem, why it matters, what to do and one button', () => {
    for (const a of buildNextActions(input({ attention: [missing], suggestions: [suggestion('a')], gaps: [gap()] }))) {
      expect(a.problem).toBeTruthy();
      expect(a.whyItMatters).toBeTruthy();
      expect(a.recommendation).toBeTruthy();
      expect(a.action.href).toMatch(/^\/dashboard\//);
    }
  });

  it('shows the same thing once when a suggestion and a gap both noticed it', () => {
    const list = buildNextActions(
      input({
        suggestions: [suggestion('ig', { what: 'Post on Instagram again this week', action: 'Publish an Instagram post on what’s new this month' })],
        gaps: [gap()],
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.source).toBe('suggestion');
    expect(list[0]!.alsoFrom).toEqual(['gap']);
    // The gap's evidence is kept on the merged action.
    expect(list[0]!.evidence).toMatch(/Last Instagram post/);
  });

  it('does not ask someone who cannot approve to approve', () => {
    expect(buildNextActions(input({ pendingApproval: 3, canApprove: false }))).toEqual([]);
  });

  it('leaves "may be out of date" notes on their own page', () => {
    expect(buildNextActions(input({ attention: [{ ...missing, severity: 'warning' }] }))).toEqual([]);
  });

  it('keeps Aura Suggests’ own order among suggestions', () => {
    const list = buildNextActions(input({ suggestions: [suggestion('first', { what: 'Launch the gift box' }), suggestion('second', { what: 'Reply to Acme pricing' })] }));
    expect(list.map((a) => a.key)).toEqual(['suggestion:first', 'suggestion:second']);
  });
});

describe('dedupeSuggestions', () => {
  const ev = (label: string) => ({ id: Math.random().toString(), source: 'Trend signal', label, detail: '', url: 'https://news.example/story', seen: '1 day ago', current: true });

  it('shows one story once, even proposed as a post and as a blog', () => {
    const { kept, merged } = dedupeSuggestions([
      suggestion('post', { what: 'Write about record whisky exports', evidence: [ev('Whisky exports hit a record')], channel: 'LinkedIn' }),
      suggestion('blog', { what: 'Blog on whisky exports booming', evidence: [ev('Whisky exports hit a record')], channel: 'Blog' }),
    ]);
    expect(kept.map((k) => k.id)).toEqual(['post']);
    expect(merged).toBe(1);
  });

  it('keeps different subjects apart', () => {
    const { kept } = dedupeSuggestions([
      suggestion('a', { what: 'Respond to Acme’s price cut' }),
      suggestion('b', { what: 'Launch the Diwali gift box' }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('measures subject overlap on the words that matter', () => {
    expect(sameSubject('Join the conversation on whisky exports', 'Whisky exports: write a post')).toBe(1);
    expect(sameSubject('Gift box launch', 'Office coffee plan')).toBe(0);
  });
});

describe('content specific to the business', () => {
  const business = { name: 'Verdant Roastery', text: 'We roast single-origin coffee in small batches. Bean subscription. Gift box.' };
  const limits = playbookFor('LINKEDIN_POST', 'LINKEDIN').limits;
  const generic = {
    hook: 'Success starts with the right mindset.',
    paragraphs: ['Every great journey begins with one step.', 'Stay consistent and keep going.', 'Your future self will thank you.'],
    cta: 'Follow for more',
    hashtags: ['#motivation'],
  };
  const base = { limits, sources: '', avoid: [], alcohol: false };

  it('recognises copy that names the business or what it sells', () => {
    expect(mentionsBusiness('Our gift box is back for Diwali.', business)).toBe(true);
    expect(mentionsBusiness('Verdant Roastery turns ten today.', business)).toBe(true);
    expect(mentionsBusiness(generic.paragraphs.join(' '), business)).toBe(false);
  });

  it('rewrites a trend post that never connects the story to the business', () => {
    const r = checkQuality('LINKEDIN_POST', generic, { ...base, business: { ...business, fromSource: true } });
    expect(r.issues.find((i) => i.code === 'generic')?.severity).toBe('block');
  });

  it('flags generic copy from a brief for a look, without blocking', () => {
    const r = checkQuality('LINKEDIN_POST', generic, { ...base, business: { ...business, fromSource: false } });
    expect(r.issues.find((i) => i.code === 'generic')?.severity).toBe('warn');
  });

  it('stays quiet when too little is known about the business to judge', () => {
    expect(mentionsBusiness('Anything at all here.', { name: 'X', text: 'Coffee' })).toBe(true);
  });
});
