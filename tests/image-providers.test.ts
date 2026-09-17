import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  listProviders,
  getProvider,
  resolveProvider,
  isAnyProviderConfigured,
  alternativeProviders,
} from '@/server/media/providers';
import { NoImageProviderError } from '@/server/media/types';

/**
 * Provider registry behaviour.
 *
 * The rules that matter here are about money and honesty: an explicit model
 * choice must never be silently swapped for another (the workspace pays for
 * what it picked), and an unconfigured provider must be reported as such rather
 * than offered and then failing mid-generation.
 */
const IMAGE_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'AGNES_API_KEY',
  'STABILITY_API_KEY',
  'REPLICATE_API_TOKEN',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of IMAGE_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of IMAGE_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('listProviders', () => {
  it('lists every implemented provider, configured or not', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain('OPENAI');
    expect(ids).toContain('GOOGLE');
    expect(ids).toContain('AGNES');
    expect(ids).toContain('STABILITY');
    expect(ids).toContain('REPLICATE');
  });

  it('names the missing environment variable for each one', () => {
    // This is what turns a dead radio button into "add this key".
    for (const provider of listProviders()) {
      expect(provider.configured).toBe(false);
      expect(provider.credentialEnv).toMatch(/API_KEY|API_TOKEN/);
    }
  });

  it('reports a provider as configured once its key is present', () => {
    process.env.STABILITY_API_KEY = 'test-key';
    const stability = listProviders().find((p) => p.id === 'STABILITY');
    expect(stability?.configured).toBe(true);
  });

  it('never exposes a key value, only the variable name', () => {
    process.env.OPENAI_API_KEY = 'sk-secret-value';
    const serialized = JSON.stringify(listProviders());
    expect(serialized).not.toContain('sk-secret-value');
  });
});

describe('resolveProvider', () => {
  it('throws a typed error when nothing is configured', () => {
    expect(isAnyProviderConfigured()).toBe(false);
    expect(() => resolveProvider()).toThrow(NoImageProviderError);
  });

  it('picks the first configured provider when none was requested', () => {
    process.env.REPLICATE_API_TOKEN = 'r8-test';
    expect(resolveProvider().id).toBe('REPLICATE');
  });

  it('honours an explicit choice that is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.STABILITY_API_KEY = 'st-test';
    expect(resolveProvider('STABILITY').id).toBe('STABILITY');
  });

  it('refuses rather than substituting when the chosen model is unconfigured', () => {
    // Silently generating on a different provider would bill the workspace for
    // something it did not choose, so this must be an error, not a fallback.
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => resolveProvider('STABILITY')).toThrow(/not configured/i);
  });

  it('rejects an unknown provider id', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    // @ts-expect-error — deliberately invalid, mirroring a hand-crafted request.
    expect(() => resolveProvider('MIDJOURNEY')).toThrow(/Unknown image provider/);
  });
});

describe('alternativeProviders', () => {
  it('offers only other providers that are actually usable', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GOOGLE_AI_API_KEY = 'g-test';

    const alternatives = alternativeProviders('OPENAI').map((p) => p.id);
    expect(alternatives).toEqual(['GOOGLE']);
  });

  it('returns nothing when the failing provider is the only one configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(alternativeProviders('OPENAI')).toEqual([]);
  });
});

describe('provider contracts', () => {
  it('gives every provider at least one supported ratio and an image cap', () => {
    for (const id of ['OPENAI', 'GOOGLE', 'AGNES', 'STABILITY', 'REPLICATE'] as const) {
      const provider = getProvider(id);
      expect(provider).not.toBeNull();
      expect(provider!.supportedRatios.length).toBeGreaterThan(0);
      expect(provider!.maxImagesPerRequest).toBeGreaterThan(0);
      expect(provider!.maxImagesPerRequest).toBeLessThanOrEqual(4);
    }
  });
});
