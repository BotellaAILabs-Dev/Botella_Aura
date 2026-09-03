import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { getModel, DEFAULT_MODEL } from '@/server/ai/claude';

/**
 * Model tiering.
 *
 * Every call used to run on the flagship model regardless of the work — a text
 * diff summary cost the same per token as the post a customer publishes. These
 * pin the two things that make tiering safe: an existing deployment that pinned
 * ANTHROPIC_MODEL keeps behaving exactly as before, and the default tier is the
 * expensive one, so an unclassified call is never silently downgraded.
 */
const KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_CHEAP',
  'ANTHROPIC_MODEL_STANDARD',
  'ANTHROPIC_MODEL_PREMIUM',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_GEMINI_API_KEY',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('tier defaults', () => {
  it('maps each tier to a distinct model', () => {
    const cheap = getModel('cheap');
    const standard = getModel('standard');
    const premium = getModel('premium');
    expect(new Set([cheap, standard, premium]).size).toBe(3);
  });

  it('keeps the flagship on the premium tier', () => {
    expect(getModel('premium')).toBe(DEFAULT_MODEL);
  });

  it('defaults to premium when no tier is given', () => {
    // The safe direction: an unclassified call keeps its old behaviour and
    // cost rather than being quietly downgraded to a weaker model.
    expect(getModel()).toBe(getModel('premium'));
  });

  it('uses a genuinely cheaper family for the cheap tier', () => {
    expect(getModel('cheap')).toMatch(/haiku/i);
    expect(getModel('standard')).toMatch(/sonnet/i);
  });
});

describe('environment overrides', () => {
  it('ANTHROPIC_MODEL still pins every tier, as it did before tiering existed', () => {
    // Back-compat: a deployment that pinned a model must not suddenly start
    // spreading calls across three different ones.
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    expect(getModel('cheap')).toBe('claude-opus-4-7');
    expect(getModel('standard')).toBe('claude-opus-4-7');
    expect(getModel('premium')).toBe('claude-opus-4-7');
  });

  it('a per-tier variable overrides just that tier', () => {
    process.env.ANTHROPIC_MODEL_CHEAP = 'claude-haiku-4-5';
    process.env.ANTHROPIC_MODEL_PREMIUM = 'claude-opus-5';
    expect(getModel('cheap')).toBe('claude-haiku-4-5');
    expect(getModel('premium')).toBe('claude-opus-5');
    // Untouched tier keeps its default.
    expect(getModel('standard')).toMatch(/sonnet/i);
  });

  it('a per-tier variable wins over the global pin', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    process.env.ANTHROPIC_MODEL_CHEAP = 'claude-haiku-4-5';
    expect(getModel('cheap')).toBe('claude-haiku-4-5');
    expect(getModel('standard')).toBe('claude-opus-4-8');
  });
});

describe('Gemini fallback', () => {
  it('ignores the tier — flash is already the cheap end of that family', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'g-test';
    expect(getModel('cheap')).toBe(getModel('premium'));
  });

  it('respects GEMINI_MODEL', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GEMINI_MODEL = 'gemini-2.5-pro';
    expect(getModel('standard')).toBe('gemini-2.5-pro');
  });
});
