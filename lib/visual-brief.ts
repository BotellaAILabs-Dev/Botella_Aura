import { z } from 'zod';

import {
  ASPECT_RATIOS,
  RATIO_DIMENSIONS,
  SOCIAL_PLATFORMS,
  platformSpec,
  type AspectRatioKey,
  type SocialPlatformKey,
} from '@/lib/platforms';

/**
 * VISUAL BRIEF — what the image-generation workflow needs to make the picture
 * for a piece of content, derived from the recommendation it serves.
 *
 * Part of the Content Brief (lib/content-brief.ts, field `visual`), and read by
 * the image prompt (server/media/image-prompt.service.ts), so the art director
 * is briefed on what the PIECE is for — the recommendation's key message, the
 * business's product, who will see it, the brand's palette and mood — instead
 * of guessing the subject from the post's first line.
 *
 *   need         required / recommended / none, and why (from the format and
 *                the channel: a single image post, a carousel or an ad cannot
 *                go out without one; an email header or blog hero helps)
 *   subject      the idea the image carries, and the product or offering in it
 *   setting      consumer imagery (the thing and the moment of using it) or
 *                business imagery (the work and its outcome)
 *   brand        palette, mood (from the brand voice), what never to show
 *   format       aspect ratio and pixel size for the channel, the other ratios
 *                it takes, file limits and the channel's art direction
 *   rules        what is never in the image — text, logos, real people, and
 *                any offer, price or claim the brief does not carry
 *   missing      what Aura does not have, what that means for the picture, and
 *                where to add it — nothing is invented
 *
 * Pure and client-safe.
 */

export const VISUAL_BRIEF_VERSION = 1 as const;

export const VISUAL_FIELDS = [
  'subject',
  'product',
  'audience',
  'palette',
  'mood',
] as const;
export type VisualField = (typeof VISUAL_FIELDS)[number];

const text = z.string().trim().min(1);

export const visualBriefSchema = z.object({
  version: z.literal(VISUAL_BRIEF_VERSION),
  need: z.enum(['required', 'recommended', 'none']),
  why: text,
  count: z.object({ min: z.number().int(), max: z.number().int() }),
  /** The idea the image carries — the piece's key message. */
  subject: z.object({ value: text, source: text }).nullable(),
  /** What the business sells, to show the real thing rather than a generic one. */
  product: z.object({ value: text, source: text }).nullable(),
  /** Who will see it. */
  audience: text.nullable(),
  /** Consumer or business imagery. */
  setting: text,
  brand: z.object({
    /** Brand colours (hex) the image should sit in. */
    palette: z.array(text),
    /** Visual mood, from the brand voice's tone. */
    mood: z.array(text),
    /** Never shown in the image. */
    avoid: z.array(text),
    /** A logo is on file — added by the business, never drawn by the model. */
    logoOnFile: z.boolean(),
  }),
  format: z.object({
    channel: text.nullable(),
    platform: z.enum(SOCIAL_PLATFORMS).nullable(),
    aspectRatio: z.enum(ASPECT_RATIOS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Other shapes the channel takes, best first. */
    ratios: z.array(z.enum(ASPECT_RATIOS)),
    minDimension: z.number().int().nullable(),
    maxFileSizeMb: z.number().nullable(),
    fileTypes: z.array(text),
    artDirection: text.nullable(),
  }),
  rules: z.array(text),
  missing: z.array(
    z.object({
      field: z.enum(VISUAL_FIELDS),
      requirement: z.enum(['required', 'recommended']),
      whenMissing: text,
      fix: z.object({ label: text, href: text }).nullable(),
    }),
  ),
  /**
   *   ready            everything an image needs is here
   *   ready_with_gaps  it can be made; the gaps are stated, not filled
   *   blocked          nothing to picture (no subject)
   *   not_needed       this format takes no image
   */
  readiness: z.enum(['ready', 'ready_with_gaps', 'blocked', 'not_needed']),
});

export type VisualBrief = z.infer<typeof visualBriefSchema>;

/** What never appears in a generated image. */
export const VISUAL_RULES = [
  'No lettering, words, logos, watermarks or UI chrome anywhere in the image — the post carries the words; a logo is added by the business, not drawn.',
  'No real people, recognisable faces or other brands’ marks.',
  'Do not depict an offer, price, discount, award or claim that the brief does not state.',
  'One coherent image, not a collage or a grid of panels.',
];

const MISSING: Record<
  VisualField,
  {
    requirement: 'required' | 'recommended';
    whenMissing: string;
    fix: { label: string; href: string } | null;
  }
> = {
  subject: {
    requirement: 'required',
    whenMissing:
      'There is no message for the image to carry — the brief needs a key message first.',
    fix: null,
  },
  product: {
    requirement: 'recommended',
    whenMissing:
      'Aura does not know what the business sells, so the image shows the idea, not your product. Add your offerings for images of the real thing.',
    fix: {
      label: 'Add what you sell',
      href: '/dashboard/business?ask=identity.offerings',
    },
  },
  audience: {
    requirement: 'recommended',
    whenMissing:
      'No audience recorded: the image is not aimed at anyone in particular.',
    fix: { label: 'Describe your audience', href: '/dashboard/business' },
  },
  palette: {
    requirement: 'recommended',
    whenMissing:
      'No brand colours: the image uses a neutral palette instead of yours. Add them so every graphic looks like it came from you.',
    fix: { label: 'Add brand colours', href: '/dashboard/settings' },
  },
  mood: {
    requirement: 'recommended',
    whenMissing: 'No brand voice yet: the mood follows the chosen style only.',
    fix: { label: 'Set your brand voice', href: '/dashboard/business' },
  },
};

export interface VisualBriefInput {
  /** From the format and network (the Content Brief's asset requirements). */
  need: 'required' | 'recommended' | 'none';
  count: { min: number; max: number };
  formatLabel: string;
  /** The ratio the format prefers on this channel (null → the channel's default). */
  aspectRatio: AspectRatioKey | null;
  platform: SocialPlatformKey | null;
  channel: string | null;
  /** The piece's key message, with where it came from. */
  keyMessage: { value: string; source: string } | null;
  /** What the business sells, else what it does. */
  offerings: string | null;
  description: string | null;
  audience: string | null;
  marketMode: 'B2B' | 'B2C' | 'BOTH' | null;
  brand: { colors: string[]; hasLogo: boolean };
  voice: { tone: string[]; avoid: string[] } | null;
}

export function buildVisualBrief(input: VisualBriefInput): VisualBrief {
  const platform = input.platform;
  const spec = platform ? platformSpec(platform) : null;
  const ratio: AspectRatioKey =
    input.aspectRatio ?? spec?.defaultRatio ?? '1:1';
  const dims = RATIO_DIMENSIONS[ratio];

  const why =
    input.need === 'required'
      ? `A ${input.formatLabel.toLowerCase()} cannot go out without ${input.count.max > 1 ? `${input.count.min}–${input.count.max} images` : 'an image'}.`
      : input.need === 'recommended'
        ? `An image is optional for a ${input.formatLabel.toLowerCase()}, but it helps it get seen.`
        : `A ${input.formatLabel.toLowerCase()} takes no image.`;

  const product = input.offerings?.trim()
    ? { value: input.offerings.trim(), source: 'business_profile' }
    : null;

  const setting =
    input.marketMode === 'B2C'
      ? 'Consumer imagery: show the thing itself and the moment of using or enjoying it — not a workplace.'
      : input.marketMode === 'B2B'
        ? 'Business imagery: show the work and its outcome — not lifestyle imagery.'
        : 'Show the business’s real product or work in a real setting; avoid generic stock scenes.';

  const voiceTone = input.voice?.tone ?? [];
  const absent: VisualField[] = [];
  if (!input.keyMessage) absent.push('subject');
  if (!product && !input.description) absent.push('product');
  if (!input.audience) absent.push('audience');
  if (input.brand.colors.length === 0) absent.push('palette');
  if (voiceTone.length === 0) absent.push('mood');

  const notNeeded = input.need === 'none';
  const missing = notNeeded
    ? []
    : absent.map((field) => ({ field, ...MISSING[field] }));
  const readiness: VisualBrief['readiness'] = notNeeded
    ? 'not_needed'
    : missing.some((m) => m.requirement === 'required')
      ? 'blocked'
      : missing.length
        ? 'ready_with_gaps'
        : 'ready';

  return visualBriefSchema.parse({
    version: VISUAL_BRIEF_VERSION,
    need: input.need,
    why,
    count: input.count,
    subject: input.keyMessage,
    product:
      product ??
      (input.description?.trim()
        ? { value: input.description.trim(), source: 'business_profile' }
        : null),
    audience: input.audience,
    setting,
    brand: {
      palette: input.brand.colors,
      mood: voiceTone,
      avoid: input.voice?.avoid ?? [],
      logoOnFile: input.brand.hasLogo,
    },
    format: {
      channel: input.channel,
      platform,
      aspectRatio: ratio,
      width: dims.width,
      height: dims.height,
      ratios: spec?.ratios ?? [ratio],
      minDimension: spec?.minDimension ?? null,
      maxFileSizeMb: spec
        ? Math.round((spec.maxFileSizeBytes / 1_048_576) * 10) / 10
        : null,
      fileTypes: spec?.acceptedMimeTypes.map((m) =>
        m.replace('image/', '').toUpperCase(),
      ) ?? ['PNG', 'JPEG'],
      artDirection: spec?.artDirection ?? null,
    },
    rules: VISUAL_RULES,
    missing,
    readiness,
  });
}

/**
 * The visual brief as the art director reads it — structured, so the image
 * prompt is built from the piece's purpose and the brand, not guessed.
 */
export function visualBriefToPrompt(v: VisualBrief): string {
  const out = ['VISUAL BRIEF (from the content brief this image serves):'];
  if (v.subject) out.push(`The idea to carry: ${v.subject.value}`);
  if (v.product)
    out.push(
      `What the business offers (show the real thing where it fits): ${v.product.value}`,
    );
  if (v.audience) out.push(`Who will see it: ${v.audience}`);
  out.push(`Setting: ${v.setting}`);
  if (v.brand.palette.length) {
    out.push(
      `Brand palette: build the image around ${v.brand.palette.join(', ')} — in lighting, surfaces and background, never as swatches or flat blocks.`,
    );
  }
  if (v.brand.mood.length)
    out.push(`Mood (from the brand voice): ${v.brand.mood.join(', ')}.`);
  if (v.brand.avoid.length)
    out.push(`Never depict: ${v.brand.avoid.join(', ')}.`);
  out.push(
    `Format: ${v.format.aspectRatio} (${v.format.width}×${v.format.height})${v.format.channel ? ` for ${v.format.channel}` : ''}.${
      v.format.artDirection ? ` ${v.format.artDirection}` : ''
    }`,
  );
  out.push(`Hard rules: ${v.rules.join(' ')}`);
  const gaps = v.missing.map((m) => m.field);
  if (gaps.length)
    out.push(`Not provided — do not invent: ${gaps.join(', ')}.`);
  return out.join('\n');
}
