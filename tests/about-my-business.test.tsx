// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));
const toasts: string[] = [];
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign((m: string) => toasts.push(m), {
    success: (m: string) => toasts.push(m),
    error: (m: string) => toasts.push(m),
  }),
}));
vi.mock('@/lib/db', () => ({ db: {} }));

import {
  buildBusinessContext,
  type BusinessContextSources,
} from '@/server/business-context/build';
import {
  attentionItems,
  confirmTarget,
  EDITABLE_FIELDS,
  freshnessIndicator,
  sourceIndicator,
} from '@/lib/business-context-ui';
import { businessContextPatchSchema } from '@/lib/validations/business-context';
import { BusinessContextView } from '@/components/dashboard/business/business-context-view';
import { NAV_ITEMS } from '@/lib/nav';
import { onboardingStep } from '@/lib/onboarding';

/**
 * About My Business: the user-facing Business Context.
 *
 * Pins the acceptance criteria: the page reflects the current context
 * (values, sources, freshness); missing information is clearly identified;
 * users can update it; and every change goes to the Business Context API
 * that all workflows read.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const meta = (sourceType: string, at: Date) => ({
  sourceType,
  capturedAt: at.toISOString(),
});

function sources(prefs: Record<string, unknown> = {}): BusinessContextSources {
  return {
    company: {
      id: 'c1',
      name: 'Verdant Roastery',
      website: 'https://verdant.coffee',
      industry: 'Food & beverage',
      brandVoiceNotes: 'Friendly, no jargon',
      brandVoiceProfile: {
        toneDescriptors: ['warm'],
        sentenceLength: 'short',
        vocabulary: [],
        commonPhrases: [],
        topicsToAvoid: [],
        formatting: { emojiUsage: 'none', hashtagStyle: 'none', notes: '' },
        summary: 'Warm and plain-spoken.',
      },
      updatedAt: daysAgo(1),
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
          goals: '200 new subscribers',
          channels: ['Instagram'],
        },
        factMeta: {
          'identity.description': meta('onboarding', daysAgo(5)),
          'audience.stated': meta('onboarding', daysAgo(5)),
          'objectives.goals': meta('user_provided', daysAgo(120)),
          'voice.profile': meta('ai_derived', daysAgo(2)),
        },
        ...prefs,
      },
    },
    connections: {
      connectorIds: [],
      linkedInConnected: false,
      lastSyncedAt: null,
    },
  };
}

const ctxOf = (src = sources()) =>
  JSON.parse(JSON.stringify(buildBusinessContext(src, NOW)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
  toasts.length = 0;
});

// ---------------------------------------------------------------------------

describe('navigation', () => {
  it('is in the sidebar under Setup, and onboarding sends users there', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/dashboard/business');
    expect(item).toMatchObject({
      label: 'About my business',
      section: 'setup',
    });
    expect(onboardingStep('business').href).toBe('/dashboard/business');
  });
});

describe('presentation rules', () => {
  it('turns every editable field into a patch the API accepts', () => {
    const samples: Record<string, string | string[]> = {
      'audience.marketMode': 'B2B',
      'channels.preferred': ['LinkedIn', 'Blog'],
      'identity.website': 'verdant.coffee',
    };
    for (const field of Object.values(EDITABLE_FIELDS)) {
      const value =
        samples[field.key] ??
        'A perfectly reasonable sentence about the business.';
      expect(
        businessContextPatchSchema.safeParse(field.toPatch(value)).success,
        field.key,
      ).toBe(true);
    }
  });

  it('labels AI-derived and fallback facts, and out-of-date ones', () => {
    const ctx = ctxOf();
    expect(sourceIndicator(ctx.meta.facts['voice.summary'])).toMatchObject({
      label: 'AI-suggested',
      tone: 'warning',
    });
    expect(sourceIndicator(ctx.meta.facts['identity.description'])?.label).toBe(
      'From onboarding',
    );
    expect(
      freshnessIndicator(ctx.meta.facts['objectives.goals']),
    ).toMatchObject({ label: 'Out of date', tone: 'warning' });
    expect(
      freshnessIndicator(ctx.meta.facts['identity.description'])?.label,
    ).toBe('Updated 5d ago');
  });

  it('offers to confirm the AI voice draft and the out-of-date goal, not trusted current facts', () => {
    const ctx = ctxOf();
    expect(
      confirmTarget(
        EDITABLE_FIELDS['voice.notes']!,
        ctx.meta.facts['voice.summary'],
      ),
    ).toBe('voice.profile');
    expect(
      confirmTarget(
        EDITABLE_FIELDS['objectives.goals']!,
        ctx.meta.facts['objectives.goals'],
      ),
    ).toBe('objectives.goals');
    expect(
      confirmTarget(
        EDITABLE_FIELDS['identity.description']!,
        ctx.meta.facts['identity.description'],
      ),
    ).toBeNull();
  });

  it('lists missing required information first, then out-of-date values', () => {
    const items = attentionItems(
      ctxOf(sources({ business: {}, marketingProfile: { goals: 'Grow' } })),
    );
    expect(items[0]).toMatchObject({
      severity: 'required',
      title: 'What the business does is missing',
      editKey: 'identity.description',
    });
    const severities = items.map((i) => i.severity);
    expect(severities.indexOf('required')).toBeLessThan(
      severities.lastIndexOf('info'),
    );
  });
});

// ---------------------------------------------------------------------------

function patchResponder(status = 200, body: unknown = { changed: [] }) {
  return vi
    .fn()
    .mockResolvedValue({ ok: status < 300, status, json: async () => body });
}

describe('the page', () => {
  it('reflects the current context: values, sources and freshness', () => {
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);
    expect(
      screen.getByText('We roast single-origin coffee in small batches.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('People who already own a grinder.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Consumers')).toBeInTheDocument();
    expect(screen.getAllByText('Out of date').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI-suggested').length).toBeGreaterThan(0);
  });

  it('clearly marks missing required information', () => {
    render(
      <BusinessContextView
        context={ctxOf(sources({ business: {} }))}
        canEdit
        logoSrc={null}
      />,
    );
    expect(
      screen.getByText('Aura is missing key information'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('What the business does is missing'),
    ).toBeInTheDocument();
    const row = document.getElementById('field-identity.description')!;
    expect(within(row).getByText('Required')).toBeInTheDocument();
  });

  it('saves an edit through the Business Context API with the revision it read', async () => {
    const fetchMock = patchResponder();
    vi.stubGlobal('fetch', fetchMock);
    const ctx = ctxOf();
    render(<BusinessContextView context={ctx} canEdit logoSrc={null} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit What you are working towards' }),
    );
    fireEvent.change(screen.getByLabelText('What you are working towards'), {
      target: { value: 'Book 20 wholesale accounts this quarter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/business-context');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      patch: {
        objectives: { goals: 'Book 20 wholesale accounts this quarter' },
      },
      expectedRevision: ctx.meta.revision,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('confirms an AI-drafted voice without changing it', async () => {
    const fetchMock = patchResponder();
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);
    fireEvent.click(screen.getByRole('button', { name: /This is right/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      patch: {},
      confirm: ['voice.profile'],
    });
  });

  it('shows the server’s reason when a change is refused', async () => {
    vi.stubGlobal(
      'fetch',
      patchResponder(422, {
        error: 'x',
        details: {
          'identity.description': [
            'Tell Aura what the business does in a sentence or two (at least 20 characters).',
          ],
        },
      }),
    );
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit What you do' }));
    fireEvent.change(screen.getByLabelText('What you do'), {
      target: { value: 'Coffee.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'at least 20 characters',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('asks the user to reload when someone else changed the business first', async () => {
    vi.stubGlobal(
      'fetch',
      patchResponder(409, { error: 'changed by someone else' }),
    );
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Industry' }));
    fireEvent.change(screen.getByLabelText('Industry'), {
      target: { value: 'Coffee' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Someone else changed this page/),
    ).toBeInTheDocument();
  });

  it('sends the revision from the last save, so a quick second edit is not refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        context: { meta: { revision: '2099-01-01T00:00:00.000Z' } },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Industry' }));
    fireEvent.change(screen.getByLabelText('Industry'), {
      target: { value: 'Coffee' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByLabelText('Industry')).toBeNull());

    // The props have not been refreshed yet; the second save must still use
    // the revision the first save returned.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Website' }));
    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'verdant.co' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).expectedRevision).toBe(
      '2099-01-01T00:00:00.000Z',
    );
  });

  it('does not offer Save until the value changes', () => {
    render(<BusinessContextView context={ctxOf()} canEdit logoSrc={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Industry' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    // Whitespace alone is not a change.
    fireEvent.change(screen.getByLabelText('Industry'), {
      target: { value: 'Food & beverage  ' },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Industry'), {
      target: { value: 'Coffee' },
    });
    expect(save).toBeEnabled();
  });

  it('is read-only for people who cannot edit', () => {
    render(
      <BusinessContextView context={ctxOf()} canEdit={false} logoSrc={null} />,
    );
    expect(screen.getByText(/view-only access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('button', { name: /This is right/ })).toBeNull();
  });
});
