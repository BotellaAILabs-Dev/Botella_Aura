import { describe, it, expect } from 'vitest';

import { geminiThinking } from '@/server/ai/claude';

/**
 * Gemini's thinking budget, from the caller's effort. Thinking tokens come out
 * of the same output budget as the answer, so routine JSON work must think
 * lightly or the answer is cut off and retried.
 */
describe('geminiThinking', () => {
  it('current models: low for routine work, high when depth was asked for', () => {
    expect(geminiThinking('gemini-flash-latest', 'medium')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinking('gemini-3.8-flash', 'low')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinking('gemini-flash-latest', 'high')).toEqual({ thinkingLevel: 'high' });
    expect(geminiThinking('gemini-3.1-pro-preview', 'max')).toEqual({ thinkingLevel: 'high' });
  });

  it('Gemini 2.5 takes a token budget instead', () => {
    expect(geminiThinking('gemini-2.5-flash', 'medium')).toEqual({ thinkingBudget: 512 });
    expect(geminiThinking('gemini-2.5-flash-lite', 'medium')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinking('gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: -1 });
  });
});
