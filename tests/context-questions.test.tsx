// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * Missing information → questions.
 *
 * Pins the acceptance criteria: Aura detects important missing context; asks
 * targeted, user-friendly questions; user answers update the Business Context;
 * and Aura does not invent what it does not know — it says so instead, and
 * does not nag about the same thing over and over.
 */

const { db, getBusinessContext, updateBusinessContext } = vi.hoisted(() => ({
  db: {
    businessContextQuestion: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
  getBusinessContext: vi.fn(),
  updateBusinessContext: vi.fn().mockResolvedValue({
    changed: ['audience.stated'],
    confirmed: [],
    revision: 'r',
  }),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/server/business-context/business-context-write.service', () => ({
  updateBusinessContext,
}));
vi.mock(
  '@/server/business-context/business-context.service',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('@/server/business-context/business-context.service')
      >();
    return { ...real, getBusinessContext };
  },
);
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(() => {}, { success: () => {}, error: () => {} }),
}));

import {
  buildBusinessContext,
  type BusinessContextSources,
} from '@/server/business-context/build';
import {
  answerToUpdate,
  detectGaps,
  questionAnswerSchema,
  questionFor,
  questionsFor,
} from '@/lib/business-context-questions';
import {
  answerQuestion,
  getQuestions,
  isAskable,
  QUESTION_RULES,
  setQuestionAside,
} from '@/server/business-context/questions.service';
import { businessContextToPrompt } from '@/server/business-context/business-context.service';
import { businessContextPatchSchema } from '@/lib/validations/business-context';
import { AuraQuestions } from '@/components/dashboard/business/aura-questions';

const NOW = new Date('2026-10-02T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const meta = (sourceType: string, at: Date) => ({
  sourceType,
  capturedAt: at.toISOString(),
});

const VOICE = {
  toneDescriptors: ['warm'],
  sentenceLength: 'short',
  vocabulary: [],
  commonPhrases: [],
  topicsToAvoid: [],
  formatting: { emojiUsage: 'none', hashtagStyle: 'none', notes: '' },
  summary: 'Warm and plain-spoken.',
};

function company(
  preferences: Record<string, unknown>,
  over: Partial<BusinessContextSources['company']> = {},
) {
  return {
    id: 'c1',
    name: 'Verdant Roastery',
    website: 'https://verdant.coffee',
    industry: 'Food & beverage',
    brandVoiceNotes: null,
    brandVoiceProfile: null,
    updatedAt: daysAgo(1),
    preferences,
    ...over,
  };
}

const ctx = (
  src: Partial<BusinessContextSources> & {
    company: BusinessContextSources['company'];
  },
) => buildBusinessContext(src, NOW);

/**
 * A workspace that has told Aura almost nothing — with its market and
 * knowledge sections loaded, so "missing" means missing, not "not loaded".
 */
const EMPTY = () =>
  ctx({
    company: company({}, { industry: null, website: null }),
    market: { competitors: [], trendConfig: null },
    knowledge: { chunkCounts: [], websiteUrls: [] },
  });

/** A described workspace with an out-of-date goal and an AI-drafted voice. */
const DESCRIBED = () =>
  ctx({
    company: company(
      {
        business: {
          description: 'We roast single-origin coffee in small batches.',
          offerings: 'Bean subscriptions',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
          goals: '200 new subscribers',
          channels: ['Instagram'],
        },
        factMeta: {
          'objectives.goals': meta('user_provided', daysAgo(120)),
          'voice.profile': meta('ai_derived', daysAgo(2)),
        },
      },
      { brandVoiceProfile: VOICE },
    ),
  });

afterEach(() => cleanup());

// ---------------------------------------------------------------------------

describe('detection rules', () => {
  it('finds critical missing information first', () => {
    const gaps = detectGaps(EMPTY());
    expect(gaps.slice(0, 3).map((g) => [g.key, g.priority])).toEqual([
      ['missing:identity.description', 'critical'],
      ['missing:audience.marketMode', 'critical'],
      ['missing:audience.stated', 'critical'],
    ]);
    expect(
      gaps.find((g) => g.key === 'missing:objectives.goals')?.priority,
    ).toBe('important');
    expect(
      gaps.find((g) => g.key === 'missing:identity.industry')?.priority,
    ).toBe('important');
    // Optional fields are identified too — answered on their own pages.
    expect(
      gaps.find((g) => g.key === 'missing:market.competitors'),
    ).toMatchObject({
      priority: 'optional',
    });
    expect(gaps.find((g) => g.key === 'missing:identity.visual')).toMatchObject(
      {
        priority: 'optional',
      },
    );
  });

  it('finds out-of-date values and unconfirmed AI guesses, not just blanks', () => {
    const keys = detectGaps(DESCRIBED()).map((g) => g.key);
    expect(keys).toContain('stale:objectives.goals');
    expect(keys).toContain('unverified:voice.summary');
    expect(keys.some((k) => k.startsWith('missing:identity.description'))).toBe(
      false,
    );
  });

  it('asks for the real value when Aura is borrowing one from the plan', () => {
    const c = ctx({
      company: company({
        marketingProfile: { marketMode: 'B2B' },
        business: {
          description: 'We make payroll software for small startups.',
        },
      }),
      plan: {
        inputs: { audience: 'Ops leads at logistics firms' },
        month: new Date('2026-10-01'),
        updatedAt: daysAgo(1),
      },
    });
    const q = questionsFor(detectGaps(c), c).find(
      (x) => x.field === 'audience.stated',
    )!;
    expect(q.kind).toBe('missing');
    expect(q.text).toContain(
      'borrowing “Ops leads at logistics firms” from your marketing plan',
    );
    expect(q.answer.current).toBe('Ops leads at logistics firms');
  });

  it('turns a conflict between sources into a "which is right?" choice', () => {
    const c = ctx({
      company: company({
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who own a grinder.',
        },
      }),
      plan: {
        inputs: { audience: 'Cafe owners buying wholesale' },
        month: new Date('2026-10-01'),
        updatedAt: daysAgo(1),
      },
    });
    const q = questionFor(
      detectGaps(c).find((g) => g.kind === 'conflict')!,
      c,
    );
    expect(q.answer.type).toBe('choice');
    expect(q.answer.choices?.map((x) => x.value)).toEqual([
      'People who own a grinder.',
      'Cafe owners buying wholesale',
    ]);
  });
});

describe('user-friendly questions', () => {
  it('asks about the audience the way the ticket describes', () => {
    const q = questionFor(
      detectGaps(EMPTY()).find((g) => g.field === 'audience.stated')!,
      EMPTY(),
    );
    expect(q.text).toBe(
      "I don't have enough information about your primary audience yet. Who are you mainly trying to reach?",
    );
    expect(q.why).toMatch(/writes to this person/);
  });

  it('asks the right kind of question for each field', () => {
    const qs = questionsFor(detectGaps(EMPTY()), EMPTY());
    expect(
      qs.find((q) => q.field === 'audience.marketMode')?.answer,
    ).toMatchObject({ type: 'choice' });
    expect(
      qs.find((q) => q.field === 'channels.preferred')?.answer,
    ).toMatchObject({ type: 'multi' });
    expect(
      qs.find((q) => q.field === 'identity.description')?.answer,
    ).toMatchObject({ type: 'textarea', max: 600 });
  });

  it('offers "yes, still right" for out-of-date and AI-drafted values', () => {
    const c = DESCRIBED();
    const stale = questionFor(
      detectGaps(c).find((g) => g.key === 'stale:objectives.goals')!,
      c,
    );
    expect(stale.text).toContain('Is this still right?');
    expect(stale.text).toContain('120 days ago');
    expect(stale.answer).toMatchObject({
      confirmable: true,
      current: '200 new subscribers',
    });
    const voice = questionFor(
      detectGaps(c).find((g) => g.key === 'unverified:voice.summary')!,
      c,
    );
    expect(voice.text).toBe(
      'I drafted your brand voice as “Warm and plain-spoken.”. Does that sound like you?',
    );
  });
});

describe('answers become Business Context updates', () => {
  it('turns every kind of answer into a valid patch', () => {
    const c = EMPTY();
    for (const q of questionsFor(detectGaps(c), c)) {
      // Link questions are answered on their own page, not here.
      if (q.answer.type === 'link') continue;
      const value =
        q.answer.type === 'choice'
          ? q.answer.choices![0]!.value
          : q.answer.type === 'multi'
            ? ['LinkedIn']
            : q.field === 'identity.website'
              ? 'verdant.coffee'
              : 'A perfectly reasonable answer about the business.';
      const { patch } = answerToUpdate(q, { value }, c);
      expect(businessContextPatchSchema.safeParse(patch).success, q.key).toBe(
        true,
      );
    }
  });

  it('confirms the AI voice profile itself when the user says it sounds right', () => {
    const c = DESCRIBED();
    expect(
      answerToUpdate(
        { field: 'voice.summary', kind: 'unverified' },
        { confirm: true },
        c,
      ),
    ).toEqual({ patch: {}, confirm: ['voice.profile'] });
  });

  it('splits a channels choice back into a list', () => {
    expect(
      answerToUpdate(
        { field: 'channels.preferred', kind: 'conflict' },
        { value: 'LinkedIn, X' },
        EMPTY(),
      ).patch,
    ).toEqual({
      channels: { preferred: ['LinkedIn', 'X'] },
    });
  });

  it('refuses an empty answer', () => {
    expect(questionAnswerSchema.safeParse({}).success).toBe(false);
  });
});

describe('Aura does not invent what it does not know', () => {
  it('tells the model plainly what is not yet known', () => {
    const out = businessContextToPrompt(EMPTY(), 'content');
    expect(out).toContain('NOT YET KNOWN');
    expect(out).toMatch(/who the buyer is/i);
    expect(out).toContain(
      'Do not guess, assume or state anything about these as fact',
    );
  });

  it('says nothing is unknown once the business has said it', () => {
    expect(businessContextToPrompt(DESCRIBED(), 'content')).not.toContain(
      'NOT YET KNOWN',
    );
  });
});

// ---------------------------------------------------------------------------

describe('repeat prevention rules', () => {
  const gap = {
    key: 'missing:objectives.goals',
    kind: 'missing' as const,
    field: 'objectives.goals' as const,
    priority: 'important' as const,
  };
  const row = (o: Record<string, unknown>) =>
    ({
      status: 'OPEN',
      snoozedUntil: null,
      timesAsked: 0,
      lastAskedAt: null,
      ...o,
    }) as never;

  it('never asks a dismissed question again', () => {
    expect(isAskable(gap, row({ status: 'DISMISSED' }), NOW)).toBe(false);
  });

  it('respects "not now" until it expires', () => {
    expect(
      isAskable(
        gap,
        row({ status: 'SNOOZED', snoozedUntil: daysAgo(-2) }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isAskable(gap, row({ status: 'SNOOZED', snoozedUntil: daysAgo(1) }), NOW),
    ).toBe(true);
  });

  it('rests a question asked three times without an answer — critical ones for less time', () => {
    const asked = (days: number) =>
      row({
        timesAsked: QUESTION_RULES.autoRestAfterAsks,
        lastAskedAt: daysAgo(days),
      });
    expect(isAskable(gap, asked(5), NOW)).toBe(false);
    expect(isAskable(gap, asked(15), NOW)).toBe(true);
    expect(isAskable({ ...gap, priority: 'critical' }, asked(5), NOW)).toBe(
      true,
    );
  });
});

describe('the questions service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.businessContextQuestion.findMany.mockResolvedValue([]);
    getBusinessContext.mockResolvedValue(EMPTY());
  });

  it('asks critical questions first and leaves optional ones for when they are needed', async () => {
    const r = await getQuestions('c1', { now: NOW, limit: 20 });
    expect(r?.questions[0]?.priority).toBe('critical');
    expect(r?.criticalCount).toBe(3);
    expect(r?.questions.some((q) => q.priority === 'optional')).toBe(false);
  });

  it('targets questions at what a workflow is about to use', async () => {
    const engagement = await getQuestions('c1', {
      now: NOW,
      workflow: 'engagement',
      limit: 20,
    });
    expect(engagement?.questions.map((q) => q.field)).not.toContain(
      'audience.stated',
    );
    expect(engagement?.questions.map((q) => q.field)).toContain(
      'identity.description',
    );
    const content = await getQuestions('c1', {
      now: NOW,
      workflow: 'content',
      limit: 20,
    });
    expect(content?.questions.map((q) => q.field)).toContain('audience.stated');
    // Optional fields are asked only by a workflow that uses them: content
    // does not write about competitors; planning does.
    expect(content?.questions.map((q) => q.field)).not.toContain(
      'market.competitors',
    );
    const planning = await getQuestions('c1', {
      now: NOW,
      workflow: 'planning',
      limit: 20,
    });
    expect(
      planning?.questions.find((q) => q.field === 'market.competitors'),
    ).toMatchObject({
      priority: 'optional',
      answer: { type: 'link', href: '/dashboard/competitors' },
    });
  });

  it('points to the right page for a question answered elsewhere, and refuses it here', async () => {
    await expect(
      answerQuestion({
        companyId: 'c1',
        userId: 'u1',
        key: 'missing:knowledge.coverage',
        answer: { value: 'x' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateBusinessContext).not.toHaveBeenCalled();
  });

  it('skips a dismissed question and records the ones it shows', async () => {
    db.businessContextQuestion.findMany.mockResolvedValue([
      {
        questionKey: 'missing:objectives.goals',
        status: 'DISMISSED',
        timesAsked: 1,
        lastAskedAt: daysAgo(3),
        snoozedUntil: null,
      },
    ]);
    const r = await getQuestions('c1', {
      now: NOW,
      limit: 20,
      markAsked: true,
    });
    expect(r?.questions.map((q) => q.key)).not.toContain(
      'missing:objectives.goals',
    );
    const marked = db.businessContextQuestion.upsert.mock.calls.map(
      (c) => c[0].where.companyId_questionKey.questionKey,
    );
    expect(marked).toContain('missing:identity.description');
  });

  it('does not count a reload within the cooldown as asking again', async () => {
    db.businessContextQuestion.findMany.mockResolvedValue([
      {
        questionKey: 'missing:identity.description',
        status: 'OPEN',
        timesAsked: 1,
        lastAskedAt: new Date(NOW.getTime() - 60_000),
        snoozedUntil: null,
      },
    ]);
    await getQuestions('c1', { now: NOW, limit: 1, markAsked: true });
    expect(db.businessContextQuestion.upsert).not.toHaveBeenCalled();
  });

  it('closes questions whose gap was filled elsewhere, and reopens ones that came back', async () => {
    getBusinessContext.mockResolvedValue(DESCRIBED());
    db.businessContextQuestion.findMany.mockResolvedValue([
      {
        questionKey: 'missing:audience.stated',
        status: 'OPEN',
        timesAsked: 1,
        lastAskedAt: daysAgo(3),
        snoozedUntil: null,
      },
      {
        questionKey: 'stale:objectives.goals',
        status: 'ANSWERED',
        timesAsked: 2,
        lastAskedAt: daysAgo(200),
        snoozedUntil: null,
      },
    ]);
    const r = await getQuestions('c1', { now: NOW, limit: 20 });
    const calls = db.businessContextQuestion.updateMany.mock.calls.map((c) => [
      c[0].where.questionKey.in,
      c[0].data.status,
    ]);
    expect(calls).toContainEqual([['missing:audience.stated'], 'RESOLVED']);
    expect(calls).toContainEqual([['stale:objectives.goals'], 'OPEN']);
    expect(r?.questions.map((q) => q.key)).toContain('stale:objectives.goals');
  });

  it('writes an answer to the Business Context and marks the question answered', async () => {
    await answerQuestion({
      companyId: 'c1',
      userId: 'u1',
      key: 'missing:audience.stated',
      answer: { value: 'Heads of marketing at small SaaS companies' },
    });
    expect(updateBusinessContext).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: {
          audience: { stated: 'Heads of marketing at small SaaS companies' },
        },
        origin: 'settings',
      }),
    );
    expect(
      db.businessContextQuestion.upsert.mock.calls[0]![0].update,
    ).toMatchObject({ status: 'ANSWERED' });
  });

  it('refuses an answer to a question that has already been answered', async () => {
    getBusinessContext.mockResolvedValue(DESCRIBED());
    await expect(
      answerQuestion({
        companyId: 'c1',
        userId: 'u1',
        key: 'missing:audience.stated',
        answer: { value: 'x' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(updateBusinessContext).not.toHaveBeenCalled();
  });

  it('lets a critical question be put off but not dismissed', async () => {
    await expect(
      setQuestionAside({
        companyId: 'c1',
        key: 'missing:audience.stated',
        mode: 'dismiss',
      }),
    ).rejects.toMatchObject({ status: 422 });
    await setQuestionAside({
      companyId: 'c1',
      key: 'missing:audience.stated',
      mode: 'snooze',
      now: NOW,
    });
    const until = db.businessContextQuestion.upsert.mock.calls[0]![0].update
      .snoozedUntil as Date;
    expect(until.getTime() - NOW.getTime()).toBe(
      QUESTION_RULES.notNowDays * 86_400_000,
    );
  });
});

// ---------------------------------------------------------------------------

describe('the questions card', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks, and sends the answer to the questions API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const c = EMPTY();
    const qs = questionsFor(detectGaps(c), c).slice(0, 3);
    render(<AuraQuestions questions={qs} openCount={6} canAnswer />);

    expect(screen.getByText('Aura has a few questions')).toBeInTheDocument();
    expect(screen.getByText(/3 more after these/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/primary audience/), {
      target: { value: 'Heads of marketing at small SaaS companies' },
    });
    const answerButtons = screen.getAllByRole('button', { name: 'Answer' });
    fireEvent.click(answerButtons[2]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      key: 'missing:audience.stated',
      action: 'answer',
      answer: { value: 'Heads of marketing at small SaaS companies' },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('offers "Doesn’t apply" only for questions that are not critical', () => {
    const c = EMPTY();
    const critical = questionsFor(detectGaps(c), c)
      .filter((q) => q.priority === 'critical')
      .slice(0, 1);
    const important = questionsFor(detectGaps(c), c)
      .filter((q) => q.priority === 'important')
      .slice(0, 1);
    const { unmount } = render(
      <AuraQuestions questions={critical} openCount={1} canAnswer />,
    );
    expect(screen.queryByRole('button', { name: /Doesn’t apply/ })).toBeNull();
    unmount();
    render(<AuraQuestions questions={important} openCount={1} canAnswer />);
    expect(
      screen.getByRole('button', { name: /Doesn’t apply/ }),
    ).toBeInTheDocument();
  });

  it('shows nothing when Aura has no questions', () => {
    const { container } = render(
      <AuraQuestions questions={[]} openCount={0} canAnswer />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
