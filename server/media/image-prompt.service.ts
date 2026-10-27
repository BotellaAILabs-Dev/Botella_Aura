import { z } from 'zod';
import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { completeStructured, isClaudeConfigured } from '@/server/ai/claude';
import { recordAudit } from '@/server/services/audit.service';
import { renderForManual } from '@/server/content/render';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import { STYLE_DIRECTION } from '@/server/media/types';
import { isImageStyle, type ImageStyleKey } from '@/lib/graphics-ui';
import { visualBriefToPrompt, type VisualBrief } from '@/lib/visual-brief';
import { visualBriefForDraft } from '@/server/media/visual-brief.service';
import {
  PEOPLE_DIRECTION,
  PEOPLE_REALISM,
  PEOPLE_REALISM_SHORT,
  PLATFORM_PHOTO_DIRECTION,
  REALISM_DIRECTION,
  cameraFor,
  isPhotographic,
  mergeNegative,
  photoNegativeFor,
  shotKindOf,
} from '@/lib/photo-realism';

/**
 * Content to image prompt.
 *
 * The point of the whole feature: a user who has just written a post should not
 * have to also be a prompt engineer. This reads the post they already approved,
 * works out what it is actually ABOUT, and writes an image prompt for it.
 *
 * Three things get folded in, and all three matter:
 *   - the post's own argument (so the graphic illustrates THIS post),
 *   - the company's brand voice profile (already generated for the text side —
 *     reused here rather than re-derived),
 *   - the target platform's art direction (a LinkedIn graphic and an Instagram
 *     graphic that look identical are wrong for both).
 *
 * There is a deterministic fallback when no LLM is configured. It is honest
 * about being a fallback: it composes a usable prompt out of the post's own
 * hook and the platform/style direction rather than pretending to have analysed
 * anything, and the caller reports `source: 'heuristic'` so the UI can say so.
 */
const PROMPT_VERSION = 'graphics.2';

const imagePromptSchema = z.object({
  /** The prompt sent to the image model. */
  prompt: z.string().min(40).max(1500),
  /** What to keep out of frame. Only some providers use it; harmless elsewhere. */
  negativePrompt: z.string().max(400).default(''),
  /** The one-line subject, shown in the UI so the user can sanity-check it. */
  subject: z.string().max(200).default(''),
});
export type ImagePromptResult = z.infer<typeof imagePromptSchema> & {
  /** 'ai' when a model wrote it, 'heuristic' when composed without one. */
  source: 'ai' | 'heuristic';
  /**
   * The visual brief it was written from (lib/visual-brief.ts) — returned so
   * the studio can show what the image is for and what is missing.
   */
  visual?: VisualBrief;
};

/**
 * Rules appended to every generated prompt.
 *
 * The text rule is the important one. Image models still render garbled
 * lettering, and a social graphic with misspelled words is worse than one with
 * no words at all — so we ask for none, and let the post's own copy carry the
 * message.
 */
const UNIVERSAL_RULES = [
  'No lettering, words, logos, watermarks or UI chrome anywhere in the image.',
  'No celebrities, identifiable public figures or other brands’ marks; any people are anonymous.',
  'Composed as a single, coherent image — not a collage or a grid of panels.',
  'High production value: deliberate composition, controlled colour, clean edges.',
].join(' ');

interface BuildArgs {
  draft: ContentDraft;
  platform: SocialPlatformKey;
  style: ImageStyleKey;
  /** Optional steer from the user ("show it as a control room, not a robot"). */
  guidance?: string;
}

export async function generateImagePrompt(
  args: BuildArgs & { userId: string | null },
): Promise<ImagePromptResult> {
  const { draft, platform, style, guidance, userId } = args;

  const contentText = renderForManual(draft, { details: false }).slice(0, 3000);
  const spec = platformSpec(platform);
  const styleDirection = STYLE_DIRECTION[style];
  // A photographic style is briefed as a photograph, in the network's
  // photographic register — the platform's own art direction is written for
  // graphics, and asking for "designed" imagery is what reads as AI art.
  const photographic = isPhotographic(style);
  const platformDirection = photographic
    ? PLATFORM_PHOTO_DIRECTION[platform]
    : spec.artDirection;
  // What the image is for: from the recommendation's brief when the draft has
  // one, else from the business context and the post (lib/visual-brief.ts).
  const visual = await visualBriefForDraft(draft, platform);

  let result: ImagePromptResult;
  if (isClaudeConfigured() && contentText.length > 0) {
    try {
      result = {
        ...(await askModel(
          draft,
          contentText,
          visual.brief,
          styleDirection,
          guidance,
          {
            photographic,
            platformDirection,
          },
        )),
        source: 'ai',
      };
    } catch (err) {
      // A failed prompt call must not cost the user their content. Fall back to
      // the deterministic composer and let them edit it by hand.
      logger.warn('image prompt: model call failed, using heuristic prompt', {
        draftId: draft.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result = heuristicPrompt(
        contentText,
        platformDirection,
        styleDirection,
        guidance,
        visual.brief,
        {
          photographic,
        },
      );
    }
  } else {
    result = heuristicPrompt(
      contentText,
      platformDirection,
      styleDirection,
      guidance,
      visual.brief,
      {
        photographic,
      },
    );
  }
  result = { ...result, visual: visual.brief };

  await recordAudit({
    action: 'GRAPHIC_PROMPT_GENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      platform,
      style,
      source: result.source,
      promptVersion: PROMPT_VERSION,
      // Where the image's context came from, and what it lacked.
      visualSource: visual.source,
      visualReadiness: visual.brief.readiness,
      visualMissing: visual.brief.missing.map((m) => m.field),
    },
  });

  return result;
}

async function askModel(
  draft: ContentDraft,
  contentText: string,
  visual: VisualBrief,
  styleDirection: string,
  guidance: string | undefined,
  opts: { photographic: boolean; platformDirection: string },
): Promise<z.infer<typeof imagePromptSchema>> {
  const company = await db.company.findUnique({
    where: { id: draft.companyId },
    select: { name: true, industry: true },
  });

  const system = [
    'You are an art director briefing an image-generation model for a social post.',
    '',
    'Your job is to decide what the post is ABOUT and describe a single image',
    'that carries that idea visually. Describe a scene, not a diagram. Be',
    'concrete about subject, composition, lighting and palette — a vague brief',
    'produces a generic stock image, which is the failure mode to avoid.',
    '',
    'Never restate the post as text-in-image. The image carries the idea; the',
    'post carries the words.',
    '',
    ...(opts.photographic
      ? [
          'This is a PHOTOGRAPH for a branded marketing post, and it must look',
          'like a real one — never like AI art. Brief it the way a commercial',
          'photographer is briefed: the real place, the real moment, who or what',
          'is in it and what they are doing, the camera, lens and aperture, the',
          'light source and time of day, and the materials. Show the business’s',
          'actual product, premises or work, not a metaphor, a concept or',
          'something "futuristic". Avoid the tells of generated images: glossy',
          'over-polish, waxy skin, perfect symmetry, HDR glow, floating objects,',
          'posed stock-photo smiles.',
          '',
        ]
      : []),
    'Respond with ONLY valid JSON. No markdown, no prose.',
  ].join('\n');

  // The structured visual brief (lib/visual-brief.ts): the idea, the product,
  // who sees it, the setting, the brand's palette and mood, what never to
  // show, and the channel's shape — instead of guessing from the post alone.
  const prompt = [
    `COMPANY: ${company?.name ?? 'the company'}${company?.industry ? ` (${company.industry})` : ''}`,
    '',
    visualBriefToPrompt(visual),
    '',
    'THE POST THIS IMAGE ACCOMPANIES:',
    contentText,
    '',
    `STYLE:\n${styleDirection}`,
    '',
    `PLATFORM:\n${opts.platformDirection}`,
    '',
    opts.photographic
      ? `PHOTOGRAPHIC REALISM (fold this into the prompt):\n${REALISM_DIRECTION}\n${PEOPLE_DIRECTION}\n`
      : '',
    // Images without people were already reading as real; images with people
    // were not. So the people brief is spelled out for the art director, who
    // decides whether the scene has any — rather than being left to the one
    // sentence above.
    opts.photographic
      ? `IF THERE ARE PEOPLE IN THE SHOT (fold this in too; skip it if the scene has none):\n${PEOPLE_REALISM}\n`
      : '',
    guidance ? `THE USER ALSO ASKED FOR:\n${guidance}\n` : '',
    `HARD RULES (fold these into the prompt):\n${UNIVERSAL_RULES}`,
    '',
    'Return JSON of this exact shape:',
    '{ "subject": string (one line: what the image shows),',
    '  "prompt": string (the full image-generation prompt, 60-200 words),',
    '  "negativePrompt": string (comma-separated things to keep out) }',
  ]
    .filter(Boolean)
    .join('\n');

  const out = await completeStructured({
    schema: imagePromptSchema,
    system,
    prompt,
    maxTokens: 1200,
    // Art direction is a short creative task, not a reasoning-heavy one, and
    // 'low' skips thinking entirely — which matters because the user is
    // watching a spinner while this runs.
    effort: 'low',
    tier: 'standard',
  });
  // The tells of a generated image are always kept out of a photograph,
  // whatever the model remembered to list — ours first, so they always fit.
  // Ordered for the shot the art director actually described, so a scene with
  // people keeps its hands-and-faces terms (lib/photo-realism.ts).
  return opts.photographic
    ? {
        ...out,
        negativePrompt: mergeNegative(
          photoNegativeFor(shotKindOf(`${out.subject} ${out.prompt}`)),
          out.negativePrompt,
        ),
      }
    : out;
}

/**
 * The negative prompt for a photograph when the shot is not known.
 *
 * Prefer photoNegativeFor(kind) — it keeps the terms that matter for the
 * actual shot. This stays for callers that have no scene to read.
 */
export const PHOTO_NEGATIVE = photoNegativeFor('people');

/**
 * Deterministic prompt composition, used when no AI provider is configured or
 * the model call fails.
 *
 * It leans on the post's own opening line — the hook is, by construction, the
 * single sentence the author thought best captured the piece — rather than
 * inventing a subject it has no basis for.
 */
export function heuristicPrompt(
  contentText: string,
  platformDirection: string,
  styleDirection: string,
  guidance?: string,
  visual?: VisualBrief,
  { photographic = true }: { photographic?: boolean } = {},
): ImagePromptResult {
  // The brief's subject (the recommendation's key message) when there is one;
  // else the post's own opening line.
  const hook = firstMeaningfulLine(contentText);
  const subject = visual?.subject?.value || hook || 'the theme of this post';

  if (photographic) {
    // A real photograph of a real moment for this business — the product,
    // the premises, the people it serves — not a "graphic" or a metaphor.
    const scene = [guidance, visual?.product?.value, subject]
      .filter(Boolean)
      .join(' ');
    const kind = shotKindOf(scene);
    const withPeople = kind === 'people' || kind === 'event';
    // The realism and the hard rules always reach the model; the person's
    // own direction is clipped to the room left; the rest are added whole,
    // most important first, while they fit (fitPrompt).
    const opening = sentence(
      `A real, professional marketing photograph for a social media post about: ${clip(subject, 200).replace(/[.!?\s]+$/, '')}. Show a specific, real moment that carries it — the actual product, place or people — not a metaphor or concept art`,
    );
    const required = [
      opening,
      cameraFor(kind),
      REALISM_DIRECTION,
      PEOPLE_DIRECTION,
      // Only where there are people to get wrong, and short — see
      // PEOPLE_REALISM_SHORT on why the full brief does not go here.
      ...(withPeople ? [PEOPLE_REALISM_SHORT] : []),
      // A prohibition, not a preference. This sat in the optional list, where
      // it was dropped whenever the budget ran out — so "never show this"
      // reached the model only when there happened to be room for it.
      visual?.brand.avoid.length
        ? sentence(`Never depict: ${visual.brand.avoid.join(', ')}`)
        : '',
    ].filter(Boolean);
    /**
     * Ordered by how specific each part is to THIS business, because the
     * budget drops whole parts from the end and says nothing about it.
     *
     * The platform register used to come first, on the reasoning that it
     * shapes the whole frame while the palette only tints it. Measured, that
     * reasoning cost the brand everything: the realism direction and the
     * people brief fill ~1,120 of the 1,328 characters available, the
     * register took the remaining 175, and the palette, the setting and the
     * product were all silently dropped — on Instagram and LinkedIn, the two
     * that matter most here. An image in the wrong colours is further from
     * the brand than one in a slightly generic register, and the register is
     * the part the realism direction and the camera line already mostly
     * carry. So the brand goes first, and the register takes what is left.
     *
     * The person's own direction still outranks all of it — fitPrompt places
     * that immediately after the opening, before any of these are weighed.
     */
    const optional = [
      // What is in the frame, before what colour it is: a photograph of the
      // wrong thing in the right palette is not closer to the brief.
      visual?.product
        ? sentence(`Where it fits, show: ${clip(visual.product.value, 200)}`)
        : '',
      visual?.brand.palette.length
        ? `Colour: built around ${visual.brand.palette.join(', ')} in light and surfaces, not as flat blocks.`
        : '',
      visual?.setting ?? '',
      platformDirection,
    ];
    return {
      prompt: fitPrompt({ required, guidance, optional }),
      negativePrompt: photoNegativeFor(kind),
      subject: subject.slice(0, 200),
      source: 'heuristic',
    };
  }

  const prompt = [
    `A premium social-media graphic representing: ${subject}.`,
    'Interpret the idea visually as a single striking scene — a metaphor or a',
    'concrete situation, not an abstract pattern.',
    visual?.product ? `Where it fits, show: ${visual.product.value}.` : '',
    visual?.setting ?? '',
    visual?.brand.palette.length
      ? `Colour: built around ${visual.brand.palette.join(', ')} in light and surfaces, not as flat blocks.`
      : '',
    visual?.brand.avoid.length ? `Never depict: ${visual.brand.avoid.join(', ')}.` : '',
    styleDirection,
    platformDirection,
    guidance ? `Additional direction: ${guidance}` : '',
    UNIVERSAL_RULES,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    prompt: prompt.slice(0, 1500),
    negativePrompt:
      'text, words, letters, typography, watermark, logo, signature, ' +
      'low quality, blurry, distorted, extra limbs, collage, grid',
    subject: subject.slice(0, 200),
    source: 'heuristic',
  };
}

/**
 * Whole parts, in order, within the schema's 1,500 characters, then the hard
 * rules (no text, no public figures), which always survive. A part that does
 * not fit is left out entirely — never cut mid-sentence.
 */
function fitPrompt(args: {
  required: string[];
  guidance?: string;
  optional: string[];
}): string {
  const room = 1500 - PHOTO_RULES.length - 1;
  const [opening, ...rest] = args.required;
  let used = args.required.join(' ').length;
  // The person's direction comes straight after the opening, clipped to fit.
  const left = Math.min(400, room - used - ' Additional direction: .'.length);
  const guidance =
    args.guidance?.trim() && left > 40
      ? sentence(`Additional direction: ${clip(args.guidance, left)}`)
      : '';
  if (guidance) used += guidance.length + 1;
  const extra: string[] = [];
  for (const part of args.optional.filter(Boolean)) {
    if (used + part.length + 1 <= room) {
      extra.push(part);
      used += part.length + 1;
    }
  }
  return [opening, guidance, ...rest, ...extra, PHOTO_RULES]
    .filter(Boolean)
    .join(' ');
}

/** The hard rules for a photograph — UNIVERSAL_RULES, in fewer words. */
const PHOTO_RULES =
  'No lettering, words, logos or watermarks anywhere in the image. No celebrities, identifiable public figures or other brands’ marks. One coherent photograph, not a collage.';

/** One sentence: trailing punctuation the text already had, once. */
const sentence = (s: string) => `${s.trim().replace(/[.!?\s]+$/, '')}.`;

/** At most `max` characters, on a word boundary. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max * 0.6 ? cut.slice(0, space) : cut;
}

/** First real sentence of the rendered post — its hook, in practice. */
function firstMeaningfulLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // Skip hashtag-only lines and fragments too short to describe anything.
    if (line.length < 12 || line.startsWith('#')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 180);
  }
  return '';
}

export function coerceStyle(value: string | undefined): ImageStyleKey {
  return value && isImageStyle(value) ? value : 'professional';
}
