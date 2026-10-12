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
const PROMPT_VERSION = 'graphics.1';

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
  'No real people, recognisable faces, or brand marks.',
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

  const contentText = renderForManual(draft).slice(0, 3000);
  const spec = platformSpec(platform);
  const styleDirection = STYLE_DIRECTION[style];
  // What the image is for: from the recommendation's brief when the draft has
  // one, else from the business context and the post (lib/visual-brief.ts).
  const visual = await visualBriefForDraft(draft, platform);

  let result: ImagePromptResult;
  if (isClaudeConfigured() && contentText.length > 0) {
    try {
      result = {
        ...(await askModel(draft, contentText, visual.brief, styleDirection, guidance)),
        source: 'ai',
      };
    } catch (err) {
      // A failed prompt call must not cost the user their content. Fall back to
      // the deterministic composer and let them edit it by hand.
      logger.warn('image prompt: model call failed, using heuristic prompt', {
        draftId: draft.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result = heuristicPrompt(contentText, spec.artDirection, styleDirection, guidance, visual.brief);
    }
  } else {
    result = heuristicPrompt(contentText, spec.artDirection, styleDirection, guidance, visual.brief);
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
  guidance?: string,
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

  return completeStructured({
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
}

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
): ImagePromptResult {
  // The brief's subject (the recommendation's key message) when there is one;
  // else the post's own opening line.
  const hook = firstMeaningfulLine(contentText);
  const subject = visual?.subject?.value || hook || 'the theme of this post';

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
