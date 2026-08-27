import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Could not generate a preview" was not a network failure — extended thinking
 * draws from the SAME max_tokens budget as the reply, so a 400-token cap could
 * be spent entirely on thinking and return a valid response containing no text.
 * The old client read that as an empty string and reported a generic failure.
 *
 * These pin the two fixes: a short/low-effort call must not request thinking at
 * all, and a response with no text must raise an error the retry path can see.
 */
const ORIGINAL_ENV = { ...process.env };
const create = vi.fn();
const stream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, stream };
  },
}));

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  stream.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function textResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

describe('complete()', () => {
  it('does not request thinking for a short, low-effort call', async () => {
    create.mockResolvedValue(textResponse('a sample post'));
    const { complete } = await import('@/server/ai/claude');

    await complete({ prompt: 'hi', maxTokens: 400, effort: 'low' });

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    // The regression: thinking here consumed the entire 400-token budget.
    expect(params.thinking).toBeUndefined();
    expect(params.max_tokens).toBe(400);
  });

  it('still requests thinking when the budget can afford it', async () => {
    create.mockResolvedValue(textResponse('considered answer'));
    const { complete } = await import('@/server/ai/claude');

    await complete({ prompt: 'hi', maxTokens: 4000, effort: 'high' });

    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });

  it('retries when a response comes back with no text, and returns the retry', async () => {
    create
      .mockResolvedValueOnce({ content: [], stop_reason: 'max_tokens' })
      .mockResolvedValueOnce(textResponse('second time lucky'));
    const { complete } = await import('@/server/ai/claude');

    const result = await complete({ prompt: 'hi', maxTokens: 1000 });

    expect(result).toBe('second time lucky');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('surfaces an empty completion as a typed error once retries are spent', async () => {
    create.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
    const { complete, EmptyCompletionError } = await import('@/server/ai/claude');

    await expect(
      complete({ prompt: 'hi', maxTokens: 1000 }),
    ).rejects.toBeInstanceOf(EmptyCompletionError);
  });

  it('does not retry a rejected key — that never improves by trying again', async () => {
    const authError = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    create.mockRejectedValue(authError);
    const { complete } = await import('@/server/ai/claude');

    await expect(complete({ prompt: 'hi' })).rejects.toThrow('invalid x-api-key');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    create
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(textResponse('ok'));
    const { complete } = await import('@/server/ai/claude');

    await expect(complete({ prompt: 'hi' })).resolves.toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
