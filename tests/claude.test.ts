import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Claude service wrapper tests with the Anthropic SDK fully mocked — no network.
 * Verifies text extraction, JSON parsing tolerance, and the not-configured guard.
 */
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: createMock,
        stream: () => ({
          finalMessage: async () => createMock(),
        }),
      };
    },
  };
});

import {
  complete,
  completeJson,
  parseJson,
  isClaudeConfigured,
  ClaudeNotConfiguredError,
} from '@/server/ai/claude';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('parseJson', () => {
  it('parses plain JSON', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(parseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('isolates JSON from surrounding prose', () => {
    expect(parseJson('Here you go: [1,2,3] — enjoy!')).toEqual([1, 2, 3]);
  });
});

describe('isClaudeConfigured', () => {
  it('reflects the presence of ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    expect(isClaudeConfigured()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(isClaudeConfigured()).toBe(false);
    expect(() => complete({ prompt: 'hi' })).rejects.toBeInstanceOf(
      ClaudeNotConfiguredError,
    );
  });
});

describe('complete / completeJson', () => {
  it('extracts text from content blocks (ignoring thinking blocks)', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    });
    const out = await complete({ prompt: 'hi', maxTokens: 100 });
    expect(out).toBe('Hello world');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('parses JSON responses via completeJson', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '[{"id":"1","aiSummary":"s","suggestedAngle":"a"}]' }],
    });
    const out = await completeJson<Array<{ id: string }>>({ prompt: 'go' });
    expect(out[0]!.id).toBe('1');
  });

  it('retries once on a transient failure', async () => {
    createMock
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const out = await complete({ prompt: 'hi', maxTokens: 100 });
    expect(out).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
