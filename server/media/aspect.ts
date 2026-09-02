import type { AspectRatioKey, SocialPlatformKey } from '@/lib/platforms';
import { ASPECT_RATIOS, platformSpec } from '@/lib/platforms';

/**
 * Aspect-ratio to pixel-size resolution, plus the "nearest supported" fallback.
 *
 * Providers each accept a different, small set of exact sizes. Rather than let
 * a route 400 because someone picked 9:16 on a provider that only draws
 * squares, we resolve to the closest thing that provider CAN draw and report
 * the substitution. A slightly different crop is a far better outcome than a
 * failed generation the user has to decode.
 */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Canonical size per ratio. Chosen to sit at or just above what the platforms
 * actually display, so nothing is upscaled on the way out.
 */
export const RATIO_DIMENSIONS: Record<AspectRatioKey, Dimensions> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 1024, height: 1280 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
};

// The human-facing names for these ratios ("Square", "Story / Reel") live in
// lib/graphics-ui.ts with the rest of the presentation strings — this module is
// geometry only.

export function ratioValue(ratio: AspectRatioKey): number {
  const dims = RATIO_DIMENSIONS[ratio];
  return dims.width / dims.height;
}

export function dimensionsFor(ratio: AspectRatioKey): Dimensions {
  return RATIO_DIMENSIONS[ratio];
}

export function isAspectRatio(value: string): value is AspectRatioKey {
  return (ASPECT_RATIOS as readonly string[]).includes(value);
}

/**
 * The supported ratio geometrically closest to what was asked for.
 *
 * Compares on log-ratio so "twice as wide" and "twice as tall" are treated as
 * equally distant. Comparing raw w/h instead would make every fallback drift
 * towards landscape, because widths above 1 are unbounded while heights below
 * it are squeezed into the 0-1 range.
 */
export function nearestSupportedRatio(
  requested: AspectRatioKey,
  supported: readonly AspectRatioKey[],
): AspectRatioKey {
  if (supported.length === 0) return requested;
  if (supported.includes(requested)) return requested;

  const target = Math.log(ratioValue(requested));
  let best = supported[0]!;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = Math.abs(Math.log(ratioValue(candidate)) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export interface ResolvedFormat {
  ratio: AspectRatioKey;
  width: number;
  height: number;
  /** True when the request could not be honoured exactly. */
  substituted: boolean;
  /** What was asked for, when it differs — surfaced in the UI. */
  requested?: AspectRatioKey;
}

/**
 * Resolve the format a generation will actually use, honouring in order: what
 * the user asked for, what the provider supports, and what the target platform
 * displays well.
 */
export function resolveFormat(args: {
  requested?: AspectRatioKey;
  platform: SocialPlatformKey;
  providerRatios: readonly AspectRatioKey[];
}): ResolvedFormat {
  const spec = platformSpec(args.platform);
  const wanted = args.requested ?? spec.defaultRatio;
  const ratio = nearestSupportedRatio(wanted, args.providerRatios);
  const dims = dimensionsFor(ratio);
  return {
    ratio,
    width: dims.width,
    height: dims.height,
    substituted: ratio !== wanted,
    ...(ratio !== wanted ? { requested: wanted } : {}),
  };
}
