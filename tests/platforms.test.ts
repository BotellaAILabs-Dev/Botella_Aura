import { describe, it, expect } from 'vitest';

import {
  SOCIAL_PLATFORMS,
  PLATFORM_SPECS,
  ASPECT_RATIOS,
  defaultPlatformFor,
  resolvePlatform,
  platformSpec,
  platformsForType,
} from '@/lib/platforms';
import { CONTENT_TYPES } from '@/lib/validations/content';
import { CONNECTORS } from '@/lib/connectors';

/**
 * The platform registry.
 *
 * The single most important property here is BACKWARD COMPATIBILITY: every
 * draft written before platform targeting existed has `platform = null`, and
 * those must keep going exactly where they went before. If `resolvePlatform`
 * ever drifts, thousands of existing drafts silently change destination.
 */

describe('platform specs', () => {
  it('describes every platform in the enum', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const spec = PLATFORM_SPECS[platform];
      expect(spec).toBeDefined();
      expect(spec.key).toBe(platform);
      expect(spec.label).toBeTruthy();
      expect(spec.artDirection.length).toBeGreaterThan(40);
    }
  });

  it('only offers ratios the studio can actually produce', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const spec = platformSpec(platform);
      expect(spec.ratios.length).toBeGreaterThan(0);
      for (const ratio of spec.ratios) {
        expect(ASPECT_RATIOS).toContain(ratio);
      }
      // The default has to be one of the platform's own supported ratios.
      expect(spec.ratios).toContain(spec.defaultRatio);
    }
  });

  it('accepts only image types the generators produce', () => {
    const producible = ['image/png', 'image/jpeg', 'image/webp'];
    for (const platform of SOCIAL_PLATFORMS) {
      for (const mime of platformSpec(platform).acceptedMimeTypes) {
        expect(producible).toContain(mime);
      }
    }
  });

  it('has sane dimension and size bounds', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const spec = platformSpec(platform);
      expect(spec.minDimension).toBeLessThan(spec.maxDimension);
      expect(spec.maxFileSizeBytes).toBeGreaterThan(1024 * 1024);
    }
  });

  it('links each platform to a connector that really exists', () => {
    // The two registries are separate on purpose (integrations vs destinations)
    // but must not drift — a platform pointing at a connector id that no longer
    // exists would send users to a settings page with nothing on it.
    const connectorIds = CONNECTORS.map((c) => c.id);
    for (const platform of SOCIAL_PLATFORMS) {
      expect(connectorIds).toContain(platformSpec(platform).connectorId);
    }
  });
});

describe('defaultPlatformFor', () => {
  it('maps every content type to a platform', () => {
    for (const type of CONTENT_TYPES) {
      expect(SOCIAL_PLATFORMS).toContain(defaultPlatformFor(type));
    }
  });

  it('preserves the pre-existing destination of each content type', () => {
    // These were the implicit destinations before targeting existed. Changing
    // any of them silently retargets every historical draft.
    expect(defaultPlatformFor('LINKEDIN_POST')).toBe('LINKEDIN');
    expect(defaultPlatformFor('CAROUSEL')).toBe('LINKEDIN');
    expect(defaultPlatformFor('BLOG')).toBe('LINKEDIN');
    expect(defaultPlatformFor('TWEET_THREAD')).toBe('X');
  });
});

describe('resolvePlatform', () => {
  it('falls back to the type default when a draft has no explicit target', () => {
    expect(resolvePlatform('LINKEDIN_POST', null)).toBe('LINKEDIN');
    expect(resolvePlatform('TWEET_THREAD', undefined)).toBe('X');
  });

  it('honours an explicit target over the default', () => {
    expect(resolvePlatform('CAROUSEL', 'INSTAGRAM')).toBe('INSTAGRAM');
  });
});

describe('platformsForType', () => {
  it('always includes the type’s own default', () => {
    for (const type of CONTENT_TYPES) {
      expect(platformsForType(type)).toContain(defaultPlatformFor(type));
    }
  });

  it('offers Instagram only for a format that suits it', () => {
    // A blog draft on Instagram is not a choice worth making by accident.
    expect(platformsForType('CAROUSEL')).toContain('INSTAGRAM');
    expect(platformsForType('BLOG')).not.toContain('INSTAGRAM');
  });
});
