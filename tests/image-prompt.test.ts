import { describe, it, expect, vi } from 'vitest';

// image-prompt.service reaches the database for the brand voice profile on the
// AI path. These tests exercise the deterministic path only, so the client is
// stubbed to keep the module importable without a database.
vi.mock('@/lib/db', () => ({ db: {} }));

import { heuristicPrompt, coerceStyle } from '@/server/media/image-prompt.service';
import { STYLE_DIRECTION } from '@/server/media/types';
import { IMAGE_STYLES, isImageStyle } from '@/lib/graphics-ui';
import { platformSpec } from '@/lib/platforms';

/**
 * Image-prompt composition.
 *
 * The AI path needs a model, so what is pinned here is the DETERMINISTIC path —
 * the one that runs when no provider is configured or the model call fails.
 * It is the difference between "graphic generation is unavailable" and "here is
 * a usable prompt you can edit", so it must never produce an empty or generic
 * brief, and it must always carry the no-text rule.
 */

describe('heuristicPrompt', () => {
  const linkedin = platformSpec('LINKEDIN').artDirection;
  const professional = STYLE_DIRECTION.professional;

  it('builds its subject from the post’s own opening line', () => {
    const content = [
      'AI agents are changing how businesses automate repetitive workflows.',
      '',
      'The teams winning with them treat agents as colleagues, not scripts.',
    ].join('\n');

    const result = heuristicPrompt(content, linkedin, professional);
    expect(result.subject).toContain('AI agents');
    expect(result.prompt).toContain('AI agents');
  });

  it('always forbids text in the image', () => {
    // Image models still render garbled lettering, and a social graphic with
    // misspelled words is worse than one with none — so this rule is not
    // optional and must survive every code path.
    const result = heuristicPrompt('Some post about pricing.', linkedin, professional);
    expect(result.prompt.toLowerCase()).toContain('no lettering');
    expect(result.negativePrompt).toContain('text');
  });

  it('carries the platform art direction through', () => {
    const instagram = platformSpec('INSTAGRAM').artDirection;
    const result = heuristicPrompt('A post about coffee.', instagram, professional);
    expect(result.prompt).toContain('scroll-stopping');
  });

  it('skips hashtag-only lines when picking a subject', () => {
    const content = ['#marketing #ai', 'Cold outreach is broken, and here is why.'].join(
      '\n',
    );
    const result = heuristicPrompt(content, linkedin, professional);
    expect(result.subject).not.toContain('#marketing');
    expect(result.subject).toContain('Cold outreach');
  });

  it('still produces a usable prompt when the content is unusable', () => {
    // An empty draft must not produce an empty prompt — the user should get
    // something they can edit rather than a blank box.
    const result = heuristicPrompt('', linkedin, professional);
    expect(result.prompt.length).toBeGreaterThan(60);
    expect(result.source).toBe('heuristic');
  });

  it('folds the user’s own direction in when given', () => {
    const result = heuristicPrompt(
      'A post about logistics.',
      linkedin,
      professional,
      'show a port at dawn, not a warehouse',
    );
    expect(result.prompt).toContain('port at dawn');
  });

  it('stays inside the schema’s length ceiling', () => {
    const long = 'A very long opening line about distributed systems. '.repeat(50);
    const result = heuristicPrompt(long, linkedin, professional);
    expect(result.prompt.length).toBeLessThanOrEqual(1500);
    expect(result.subject.length).toBeLessThanOrEqual(200);
  });
});

describe('styles', () => {
  it('has direction text for every offered style', () => {
    for (const style of IMAGE_STYLES) {
      expect(STYLE_DIRECTION[style]).toBeTruthy();
      expect(STYLE_DIRECTION[style].length).toBeGreaterThan(30);
    }
  });

  it('recognises valid styles and rejects anything else', () => {
    expect(isImageStyle('cinematic')).toBe(true);
    expect(isImageStyle('watercolour')).toBe(false);
  });

  it('falls back to professional for unknown or missing input', () => {
    expect(coerceStyle(undefined)).toBe('professional');
    expect(coerceStyle('nonsense')).toBe('professional');
    expect(coerceStyle('minimal')).toBe('minimal');
  });
});
