import type { AspectRatioKey, SocialPlatformKey } from '@/lib/platforms';
import { ASPECT_RATIOS, platformSpec, RATIO_DIMENSIONS } from '@/lib/platforms';

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

// Canonical size per ratio — defined with the platforms (lib/platforms.ts) so
// client-safe code (the visual brief) reads the same sizes the generator uses.
export { RATIO_DIMENSIONS } from '@/lib/platforms';

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
  return nearestRatioTo(ratioValue(requested), supported);
}

/**
 * The supported ratio closest to an arbitrary width/height.
 *
 * Two callers need this rather than the enum-to-enum version above: a CUSTOM
 * format, where the user typed their own dimensions, and a supplied image,
 * whose real shape is whatever the file happens to be. Both have to be filed
 * under one of the ratios the rest of the system understands.
 */
export function nearestRatioTo(
  value: number,
  supported: readonly AspectRatioKey[] = ASPECT_RATIOS,
): AspectRatioKey {
  const pool = supported.length > 0 ? supported : ASPECT_RATIOS;
  const target = Math.log(value);
  let best = pool[0]!;
  let bestDistance = Infinity;
  for (const candidate of pool) {
    const distance = Math.abs(Math.log(ratioValue(candidate)) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** The ratio bucket an image of these dimensions belongs to. */
export function closestRatioFor(width: number, height: number): AspectRatioKey {
  if (width <= 0 || height <= 0) return '1:1';
  return nearestRatioTo(width / height);
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
  /**
   * Explicit pixel dimensions from the studio's "Custom" format.
   *
   * Providers accept only their own fixed sizes, so arbitrary dimensions cannot
   * be honoured literally. They are honoured in SHAPE: the closest supported
   * ratio is used and the substitution is reported, which is far better than
   * refusing the request or silently drawing a square.
   */
  custom?: { width: number; height: number };
  platform: SocialPlatformKey;
  providerRatios: readonly AspectRatioKey[];
}): ResolvedFormat {
  const spec = platformSpec(args.platform);

  if (args.custom && args.custom.width > 0 && args.custom.height > 0) {
    const ratio = nearestRatioTo(
      args.custom.width / args.custom.height,
      args.providerRatios,
    );
    const dims = dimensionsFor(ratio);
    // Always flagged as substituted: the output is the nearest supported shape,
    // not the exact pixels asked for, and the UI must be able to say so.
    return {
      ratio,
      width: dims.width,
      height: dims.height,
      substituted: true,
      requested: ratio,
    };
  }

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
