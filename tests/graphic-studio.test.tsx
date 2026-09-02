// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// The studio calls router.refresh() after attaching, and toasts on every
// outcome. Neither is what these tests are about, so both are stubbed.
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const toastCalls: string[] = [];
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(
    (message: string) => {
      toastCalls.push(message);
    },
    {
      success: (message: string) => toastCalls.push(message),
      error: (message: string) => toastCalls.push(message),
    },
  ),
}));

import { GraphicStudio } from '@/components/dashboard/content/graphic-studio';

/**
 * Graphic Studio UI.
 *
 * Focused on the behaviours that protect the user and their money: an
 * unconfigured provider must say what to add rather than fail on submit, a
 * failed generation must offer a way forward without losing the post, and a
 * double click must not become a double charge.
 */
const PROVIDERS = {
  providers: [
    {
      id: 'OPENAI',
      label: 'OpenAI',
      model: 'gpt-image-1',
      description: 'Strong prompt adherence.',
      configured: true,
      credentialEnv: 'OPENAI_API_KEY',
      supportedRatios: ['1:1', '4:5', '16:9'],
      maxImagesPerRequest: 4,
    },
    {
      id: 'STABILITY',
      label: 'Stability AI',
      model: 'stable-image-core',
      description: 'Fast and inexpensive.',
      configured: false,
      credentialEnv: 'STABILITY_API_KEY',
      supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
      maxImagesPerRequest: 4,
    },
  ],
  usage: { used: 4, limit: 100, remaining: 96, maxPerRequest: 4, plan: 'Growth' },
  storage: 'DATABASE',
};

const PROMPT_RESPONSE = {
  prompt:
    'A premium professional graphic representing AI agents coordinating business workflows across a calm, modern operations space.',
  negativePrompt: 'text, watermark',
  subject: 'AI agents coordinating business workflows',
  source: 'ai',
  platform: 'LINKEDIN',
};

function baseProps(overrides: Partial<Parameters<typeof GraphicStudio>[0]> = {}) {
  return {
    draftId: 'draft_1',
    platform: 'LINKEDIN' as const,
    platformLabel: 'LinkedIn',
    defaultRatio: '1:1' as const,
    initialAssets: [],
    attachedAssetIds: [],
    activeJobId: null,
    canEdit: true,
    ...overrides,
  };
}

/** Route fetch by URL so each test only declares what it cares about. */
function mockFetch(handlers: Record<string, () => unknown>) {
  return vi.fn(async (url: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        const body = handler();
        if (body instanceof Error) {
          return { ok: false, json: async () => ({ error: body.message }) };
        }
        return { ok: true, json: async () => body };
      }
    }
    return { ok: true, json: async () => ({}) };
  });
}

beforeEach(() => {
  toastCalls.length = 0;
  refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GraphicStudio — entry point', () => {
  it('starts collapsed, so opening a draft costs nothing', () => {
    vi.stubGlobal('fetch', mockFetch({}));
    render(<GraphicStudio {...baseProps()} />);

    expect(
      screen.getByRole('button', { name: /generate graphic/i }),
    ).toBeInTheDocument();
    // No prompt box until the user asks for one.
    expect(screen.queryByLabelText(/image prompt/i)).not.toBeInTheDocument();
  });

  it('is disabled for a read-only role', () => {
    vi.stubGlobal('fetch', mockFetch({}));
    render(<GraphicStudio {...baseProps({ canEdit: false })} />);

    expect(screen.getByRole('button', { name: /generate graphic/i })).toBeDisabled();
  });

  it('reattaches to a run already in flight after a page reload', async () => {
    // Generation outlives the page — the run finishes server-side even if the
    // tab is closed. Reloading mid-run must pick it back up, not show an idle
    // panel while images are still being made.
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('providers')) {
          return { ok: true, json: async () => PROVIDERS };
        }
        if (url.includes('/api/jobs/job_live')) {
          polls++;
          return {
            ok: true,
            json: async () => ({
              status: 'SUCCEEDED',
              progress: { percent: 100 },
              result: { assets: [ASSET] },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<GraphicStudio {...baseProps({ activeJobId: 'job_live' })} />);

    // Opens expanded and busy without the user pressing anything.
    expect(screen.getByLabelText(/image prompt/i)).toBeInTheDocument();

    expect(
      await screen.findByText(/selected graphic/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(polls).toBeGreaterThan(0);
  });

  it('opens already expanded when the draft has graphics', () => {
    vi.stubGlobal('fetch', mockFetch({ providers: () => PROVIDERS }));
    render(
      <GraphicStudio
        {...baseProps({
          initialAssets: [
            {
              id: 'asset_1',
              url: '/api/content/graphics/asset_1/file',
              provider: 'OPENAI',
              model: 'gpt-image-1',
              prompt: 'a prompt',
              aspectRatio: '1:1',
              width: 1024,
              height: 1024,
              mimeType: 'image/png',
              fileSize: 1_400_000,
              createdAt: new Date().toISOString(),
              attached: false,
            },
          ],
        })}
      />,
    );

    expect(screen.getByLabelText(/image prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/generated graphics/i)).toBeInTheDocument();
  });
});

describe('GraphicStudio — prompt generation', () => {
  it('writes a prompt from the post content and shows what it will draw', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providers: () => PROVIDERS,
        'graphics/prompt': () => PROMPT_RESPONSE,
      }),
    );
    render(<GraphicStudio {...baseProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/image prompt/i)).toHaveValue(
        PROMPT_RESPONSE.prompt,
      );
    });
    // Scoped to the "Shows:" line rather than a bare text match — the subject
    // also appears inside the prompt itself, so a loose query matches twice.
    expect(screen.getByText(/^Shows:$/).parentElement).toHaveTextContent(
      /AI agents coordinating business workflows/i,
    );
  });

  it('flags a prompt written without AI, so the user knows to edit it', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providers: () => PROVIDERS,
        'graphics/prompt': () => ({ ...PROMPT_RESPONSE, source: 'heuristic' }),
      }),
    );
    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));

    await waitFor(() => {
      expect(screen.getByText(/without AI/i)).toBeInTheDocument();
    });
  });
});

describe('GraphicStudio — model selector', () => {
  it('marks an unconfigured provider and names the key to add', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providers: () => PROVIDERS,
        'graphics/prompt': () => PROMPT_RESPONSE,
      }),
    );
    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));

    const select = (await screen.findByLabelText(/model/i)) as HTMLSelectElement;
    const unconfigured = Array.from(select.options).find((o) =>
      o.textContent?.includes('Stability'),
    );
    expect(unconfigured?.disabled).toBe(true);
    expect(unconfigured?.textContent).toMatch(/not configured/i);
  });

  it('shows the remaining monthly allowance before anything is spent', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providers: () => PROVIDERS,
        'graphics/prompt': () => PROMPT_RESPONSE,
      }),
    );
    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));

    expect(
      await screen.findByText(/96 of 100 graphics left this month/i),
    ).toBeInTheDocument();
  });
});

const ASSET = {
  id: 'asset_new',
  url: '/api/content/graphics/asset_new/file',
  provider: 'OPENAI',
  model: 'gpt-image-1',
  prompt: PROMPT_RESPONSE.prompt,
  aspectRatio: '1:1',
  width: 1024,
  height: 1024,
  mimeType: 'image/png',
  fileSize: 1_400_000,
  createdAt: new Date().toISOString(),
  attached: false,
};

/**
 * Generation is queued as a background job, so the client's job is: POST the
 * request, kick the runner, poll until it settles. These fake that whole
 * round-trip rather than only the first request.
 */
describe('GraphicStudio — generation', () => {
  it('queues a job, kicks the runner, and renders the result it polls back', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        seen.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.includes('providers')) {
          return { ok: true, json: async () => PROVIDERS };
        }
        if (url.includes('graphics/prompt')) {
          return { ok: true, json: async () => PROMPT_RESPONSE };
        }
        if (url.includes('/graphics') && init?.method === 'POST') {
          return { ok: true, json: async () => ({ jobId: 'job_1', status: 'QUEUED' }) };
        }
        if (url.includes('/api/jobs/job_1/run')) {
          return { ok: true, json: async () => ({ ran: true }) };
        }
        if (url.includes('/api/jobs/job_1')) {
          return {
            ok: true,
            json: async () => ({
              status: 'SUCCEEDED',
              progress: { percent: 100 },
              result: { assets: [ASSET], aspectRatio: '1:1' },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));
    await screen.findByLabelText(/image prompt/i);

    fireEvent.click(screen.getByRole('button', { name: /generate image/i }));

    expect(await screen.findByText(/selected graphic/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
    // The runner must actually be kicked; queueing alone would hang forever.
    expect(seen.some((s) => s === 'POST /api/jobs/job_1/run')).toBe(true);
  });

  it('does not queue a second job while one is in flight', async () => {
    // Image generation is the one action here that costs real money, so a
    // double click must not become a double charge.
    let queueCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes('providers')) {
          return { ok: true, json: async () => PROVIDERS };
        }
        if (url.includes('graphics/prompt')) {
          return { ok: true, json: async () => PROMPT_RESPONSE };
        }
        if (url.includes('/graphics') && init?.method === 'POST') {
          queueCalls++;
          return { ok: true, json: async () => ({ jobId: 'job_1', status: 'QUEUED' }) };
        }
        if (url.includes('/api/jobs/job_1/run')) {
          return { ok: true, json: async () => ({ ran: true }) };
        }
        return {
          ok: true,
          json: async () => ({
            status: 'SUCCEEDED',
            progress: { percent: 100 },
            result: { assets: [ASSET] },
          }),
        };
      }),
    );

    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));
    await screen.findByLabelText(/image prompt/i);

    const button = screen.getByRole('button', { name: /generate image/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(queueCalls).toBe(1));
  });

  it('surfaces a failed job with retry and another model, and keeps the post', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes('providers')) {
          return {
            ok: true,
            json: async () => ({
              ...PROVIDERS,
              providers: PROVIDERS.providers.map((p) => ({ ...p, configured: true })),
            }),
          };
        }
        if (url.includes('graphics/prompt')) {
          return { ok: true, json: async () => PROMPT_RESPONSE };
        }
        if (url.includes('/graphics') && init?.method === 'POST') {
          return { ok: true, json: async () => ({ jobId: 'job_1', status: 'QUEUED' }) };
        }
        if (url.includes('/api/jobs/job_1/run')) {
          return { ok: true, json: async () => ({ ran: false }) };
        }
        return {
          ok: true,
          json: async () => ({
            status: 'FAILED',
            error: 'OpenAI is rate-limiting image generation right now.',
          }),
        };
      }),
    );

    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));
    await screen.findByLabelText(/image prompt/i);

    fireEvent.click(screen.getByRole('button', { name: /generate image/i }));

    expect(
      await screen.findByText(/image generation failed/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/rate-limiting/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try stability ai/i }),
    ).toBeInTheDocument();
    // The prompt — and therefore the user's work — survives the failure.
    expect(screen.getByLabelText(/image prompt/i)).toHaveValue(PROMPT_RESPONSE.prompt);
  });

  it('rejects a queue request the server refuses, without polling', async () => {
    // Entitlement and rate-limit refusals come back on the POST itself, before
    // a job exists — the user should see them immediately.
    vi.stubGlobal(
      'fetch',
      mockFetch({
        providers: () => PROVIDERS,
        'graphics/prompt': () => PROMPT_RESPONSE,
        'drafts/draft_1/graphics': () =>
          new Error('Your Trial plan includes 20 generated graphics per month.'),
      }),
    );

    render(<GraphicStudio {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /generate graphic/i }));
    await screen.findByLabelText(/image prompt/i);

    fireEvent.click(screen.getByRole('button', { name: /generate image/i }));

    expect(await screen.findByText(/20 generated graphics per month/i)).toBeInTheDocument();
  });
});
