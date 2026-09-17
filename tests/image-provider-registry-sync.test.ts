import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { ImageProvider } from '@prisma/client';
import { IMAGE_PROVIDERS } from '@/lib/validations/media';
import { listProviders } from '@/server/media/providers';

/**
 * The three lists that describe image providers must agree.
 *
 * Adding a provider means touching three places: the Prisma `ImageProvider`
 * enum (so the asset row can be written), the provider registry (so it can be
 * called), and `IMAGE_PROVIDERS` in the validation schema (so the request is
 * accepted). Miss the third and the studio offers a model whose requests are
 * rejected — which is exactly what happened when Agnes was added: selecting it
 * produced a bare "Validation failed" naming no field.
 *
 * These tests exist so the next addition fails here instead.
 */
describe('image provider lists agree', () => {
  /** Provenance only — nobody can ask a generator for an upload. */
  const NOT_SELECTABLE = new Set(['UPLOAD']);

  const enumValues = Object.values(ImageProvider).filter(
    (v) => !NOT_SELECTABLE.has(v),
  );

  it('every selectable Prisma enum value is accepted by the request schema', () => {
    for (const value of enumValues) {
      expect(
        (IMAGE_PROVIDERS as readonly string[]).includes(value),
        `${value} is in the Prisma enum but missing from IMAGE_PROVIDERS, so ` +
          `the studio would reject a request selecting it`,
      ).toBe(true);
    }
  });

  it('the request schema names no provider the database cannot store', () => {
    for (const value of IMAGE_PROVIDERS) {
      expect(
        Object.values(ImageProvider).includes(value as ImageProvider),
        `${value} is accepted by IMAGE_PROVIDERS but is not a Prisma enum ` +
          `value, so persisting the generated asset would fail`,
      ).toBe(true);
    }
  });

  it('every registered provider can actually be requested', () => {
    for (const provider of listProviders()) {
      expect(
        (IMAGE_PROVIDERS as readonly string[]).includes(provider.id),
        `${provider.id} is offered by the registry but would be rejected by ` +
          `the request schema`,
      ).toBe(true);
    }
  });

  /**
   * A provider with no label or model would render as an empty row in the
   * selector, which reads as a broken UI rather than a missing integration.
   */
  it('every registered provider is presentable in the selector', () => {
    for (const provider of listProviders()) {
      expect(provider.label.length, `${provider.id} label`).toBeGreaterThan(0);
      expect(provider.model.length, `${provider.id} model`).toBeGreaterThan(0);
      expect(provider.description.length, `${provider.id} description`).toBeGreaterThan(0);
      expect(provider.credentialEnv.length, `${provider.id} credentialEnv`).toBeGreaterThan(0);
      expect(
        provider.supportedRatios.length,
        `${provider.id} declares no ratios, so format resolution has nothing to pick`,
      ).toBeGreaterThan(0);
      expect(
        provider.maxImagesPerRequest,
        `${provider.id} must accept at least one image per request`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('includes Agnes, the provider this suite was written for', () => {
    expect((IMAGE_PROVIDERS as readonly string[])).toContain('AGNES');
    expect(listProviders().map((p) => p.id)).toContain('AGNES');
  });
});
