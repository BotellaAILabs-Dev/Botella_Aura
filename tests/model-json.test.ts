import { describe, expect, it } from 'vitest';

import { parseJson } from '@/server/ai/claude';

/**
 * Reading JSON back from a model.
 *
 * The writer asks for JSON and gets JSON almost always. The rest of the time it
 * gets JavaScript: a comma before the closing brace, or a property name
 * without quotes. `completeStructured` already retries once, and when both
 * attempts land on the same habit the person is shown a SyntaxError about a
 * character position in a document they never saw.
 *
 * The repair is a second chance only — valid JSON is parsed before it is ever
 * reached, so nothing that already parses is rewritten. What matters most here
 * is the other direction: the same characters inside a caption are content, and
 * the repair must not touch them.
 */
describe('parseJson', () => {
  it('reads plain JSON', () => {
    expect(parseJson('{"hook":"Hi","body":"There"}')).toEqual({
      hook: 'Hi',
      body: 'There',
    });
  });

  it('reads JSON out of a fenced block with prose around it', () => {
    const raw = 'Sure, here you go:\n```json\n{"hook":"Hi"}\n```\nHope that helps.';
    expect(parseJson(raw)).toEqual({ hook: 'Hi' });
  });

  it('forgives a comma before a closing brace or bracket', () => {
    expect(
      parseJson('{\n  "hook": "Hi",\n  "hashtags": ["a", "b",],\n}'),
    ).toEqual({ hook: 'Hi', hashtags: ['a', 'b'] });
  });

  it('forgives a property name written without quotes', () => {
    expect(parseJson('{ hook: "Hi", body: "There" }')).toEqual({
      hook: 'Hi',
      body: 'There',
    });
  });

  it('forgives both at once, nested', () => {
    const raw = `{
      hook: "Autumn in Bardstown",
      body: { caption: "Stop by.", cta: "Visit us.", },
      hashtags: ["bourbon",],
    }`;
    expect(parseJson(raw)).toEqual({
      hook: 'Autumn in Bardstown',
      body: { caption: 'Stop by.', cta: 'Visit us.' },
      hashtags: ['bourbon'],
    });
  });

  // --- What the repair must never do ------------------------------------

  it('leaves a caption that ends in a comma and a brace alone', () => {
    const copy = 'Smooth, slow-steeped, and ready when you are, }';
    const parsed = parseJson<{ caption: string }>(
      JSON.stringify({ caption: copy }),
    );
    expect(parsed.caption).toBe(copy);
  });

  it('does not quote something that only looks like a key inside a string', () => {
    const copy = 'Our rule: hook: always first';
    const parsed = parseJson<{ caption: string }>(
      JSON.stringify({ caption: copy }),
    );
    expect(parsed.caption).toBe(copy);
  });

  it('keeps escaped quotes and backslashes in copy', () => {
    const copy = 'She said "hello" \\ then left';
    const parsed = parseJson<{ caption: string }>(
      JSON.stringify({ caption: copy }),
    );
    expect(parsed.caption).toBe(copy);
  });

  /**
   * The original error is the one that names where the real problem was, so a
   * document the repair cannot save must fail with that, not with a second
   * error about the rewritten text.
   */
  it('still throws, about the original text, on something unsalvageable', () => {
    expect(() => parseJson('{"hook": "unclosed string}')).toThrow(SyntaxError);
    expect(() => parseJson('not json at all')).toThrow();
  });
});
