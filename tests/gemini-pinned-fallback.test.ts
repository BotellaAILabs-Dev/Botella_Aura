import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { complete, resetPinnedModelHealth } from '@/server/ai/claude';

/**
 * A pinned Gemini model that has stopped answering must not take Content
 * Studio down with it. `gemini-flash-latest` (pinned in a local .env) was
 * measured giving no answer in 90 s for a request the default answers in 2 s.
 */

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

const modelOf = (call: unknown[]) => String(call[0]).match(/models\/([^:]+):/)?.[1];

describe('a pinned Gemini model that fails', () => {
  const saved = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GEMINI_MODEL = 'gemini-flash-latest';
    resetPinnedModelHealth();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('falls back to the default when the pinned model is not found, then skips it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 })).mockImplementation(async () => ok('hello'));
    expect(await complete({ prompt: 'hi', maxAttempts: 1 })).toBe('hello');
    expect(fetchMock.mock.calls.map(modelOf)).toEqual(['gemini-flash-latest', 'gemini-3.5-flash-lite']);

    await complete({ prompt: 'again', maxAttempts: 1 });
    expect(modelOf(fetchMock.mock.calls[2]!)).toBe('gemini-3.5-flash-lite');
  });

  it('falls back when the pinned model does not answer in time', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
      .mockImplementation(async () => ok('fast'));
    expect(await complete({ prompt: 'hi', maxAttempts: 1 })).toBe('fast');
    expect(fetchMock.mock.calls.map(modelOf)).toEqual(['gemini-flash-latest', 'gemini-3.5-flash-lite']);
  });

  it('keeps using a pinned model that works', async () => {
    fetchMock.mockImplementation(async () => ok('pinned'));
    await complete({ prompt: 'hi', maxAttempts: 1 });
    await complete({ prompt: 'hi', maxAttempts: 1 });
    expect(fetchMock.mock.calls.map(modelOf)).toEqual(['gemini-flash-latest', 'gemini-flash-latest']);
  });

  it('does not hide a problem the default model would share (a bad key)', async () => {
    fetchMock.mockImplementation(async () => new Response('API key not valid', { status: 400 }));
    await expect(complete({ prompt: 'hi', maxAttempts: 1 })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
