import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getModel } from '@/server/ai/claude';

/**
 * Which model each tier resolves to.
 *
 * The Gemini path used to ignore the tier entirely, on the reasoning that
 * "Gemini's flash model is already the cheap end of that family". That held
 * until `gemini-flash-latest` — an alias Google moves — started taking over
 * 45 seconds to answer a small JSON request.
 *
 * Nothing threw. The WhatsApp router has a 15-second budget, so it timed out,
 * retried, timed out again and fell back to its menu, which reads to a user as
 * "Sorry, I didn't catch that" in reply to a perfectly clear sentence. These
 * tests exist so a fast model cannot silently become a slow one again.
 */

const KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_CHEAP',
  'ANTHROPIC_MODEL_STANDARD',
  'ANTHROPIC_MODEL_PREMIUM',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_MODEL_CHEAP',
  'GEMINI_MODEL_STANDARD',
  'GEMINI_MODEL_PREMIUM',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('Anthropic is preferred when it is configured', () => {
  it('gives each tier its own model', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const tiers = [getModel('cheap'), getModel('standard'), getModel('premium')];
    expect(new Set(tiers).size).toBe(3);
  });

  it('wins even when Gemini is also configured', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'g-test';
    expect(getModel('premium')).not.toMatch(/gemini/i);
  });
});

describe('the Gemini fallback honours the tier', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'g-test';
  });

  it('never resolves to the slow moving alias by default', () => {
    // The specific regression: `gemini-flash-latest` is an alias Google
    // repoints, and it currently blows every interactive timeout.
    for (const tier of ['cheap', 'standard', 'premium'] as const) {
      expect(getModel(tier)).not.toBe('gemini-flash-latest');
    }
  });

  it('defaults every tier to a model that was actually timed', () => {
    for (const tier of ['cheap', 'standard', 'premium'] as const) {
      expect(getModel(tier)).toBe('gemini-3.5-flash-lite');
    }
  });

  it('lets a deployment set each tier on its own', () => {
    process.env.GEMINI_MODEL_CHEAP = 'fast-one';
    process.env.GEMINI_MODEL_PREMIUM = 'good-one';
    expect(getModel('cheap')).toBe('fast-one');
    expect(getModel('premium')).toBe('good-one');
    // Untouched tiers keep the default rather than inheriting a neighbour.
    expect(getModel('standard')).toBe('gemini-3.5-flash-lite');
  });

  it('still respects a global GEMINI_MODEL pin, for back-compatibility', () => {
    // A deployment that pinned a model before tiering existed must keep
    // behaving exactly as it did — including pinning the slow alias.
    process.env.GEMINI_MODEL = 'gemini-flash-latest';
    for (const tier of ['cheap', 'standard', 'premium'] as const) {
      expect(getModel(tier)).toBe('gemini-flash-latest');
    }
  });

  it('prefers the per-tier variable over the global pin', () => {
    process.env.GEMINI_MODEL = 'pinned-everywhere';
    process.env.GEMINI_MODEL_CHEAP = 'cheap-only';
    expect(getModel('cheap')).toBe('cheap-only');
    expect(getModel('premium')).toBe('pinned-everywhere');
  });

  it('reads the alternative key name too', () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_GEMINI_API_KEY = 'g-test';
    expect(getModel('cheap')).toBe('gemini-3.5-flash-lite');
  });
});
