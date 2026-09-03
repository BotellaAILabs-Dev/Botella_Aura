import { z } from 'zod';
import type { Company, ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { completeStructured, isClaudeConfigured } from '@/server/ai/claude';
import { recordAudit } from '@/server/services/audit.service';
import { renderForManual } from '@/server/content/render';
import { brandVoiceProfileSchema } from '@/lib/validations/content';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import { STYLE_DIRECTION } from '@/server/media/types';
import { isImageStyle, type ImageStyleKey } from '@/lib/graphics-ui';
import { readBrandAssets } from '@/server/company/profile.service';

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

  let result: ImagePromptResult;
  if (isClaudeConfigured() && contentText.length > 0) {
    try {
      result = { ...(await askModel(draft, contentText, spec.artDirection, styleDirection, guidance)), source: 'ai' };
    } catch (err) {
      // A failed prompt call must not cost the user their content. Fall back to
      // the deterministic composer and let them edit it by hand.
      logger.warn('image prompt: model call failed, using heuristic prompt', {
        draftId: draft.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result = heuristicPrompt(contentText, spec.artDirection, styleDirection, guidance);
    }
  } else {
    result = heuristicPrompt(contentText, spec.artDirection, styleDirection, guidance);
  }

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
    },
  });

  return result;
}

async function askModel(
  draft: ContentDraft,
  contentText: string,
  platformDirection: string,
  styleDirection: string,
  guidance?: string,
): Promise<z.infer<typeof imagePromptSchema>> {
  const company = await db.company.findUnique({
    where: { id: draft.companyId },
    select: { name: true, industry: true, brandVoiceProfile: true, preferences: true },
  });

  // Reuse the brand voice profile already generated for the text side, but
  // translated into VISUAL direction — brandVoiceToPrompt() phrases it as
  // writing instructions ("write exactly in this voice"), which would steer an
  // art director badly. safeParse because a profile stored before a schema
  // change must not break generation.
  const voiceBlock = brandVoiceToVisualDirection(company?.brandVoiceProfile);

  // The workspace's own palette, when it has given one. An art director told
  // the actual brand colours produces creatives that look like they came from
  // this company; without it every image is whatever the model finds pretty.
  const paletteBlock = company ? brandPaletteDirection(company) : '';

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

  const prompt = [
    `COMPANY: ${company?.name ?? 'the company'}${company?.industry ? ` (${company.industry})` : ''}`,
    voiceBlock,
    paletteBlock,
    '',
    'THE POST THIS IMAGE ACCOMPANIES:',
    contentText,
    '',
    `PLATFORM ART DIRECTION:\n${platformDirection}`,
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
 * The workspace's brand colours, as palette direction.
 *
 * Stated as a constraint on the dominant colours rather than "use these
 * colours": an image-generation model handed a hex list tends to produce a
 * swatch board. What is wanted is a picture that happens to sit in the brand's
 * palette, which is what an art director would actually ask for.
 */
function brandPaletteDirection(company: Pick<Company, 'preferences'>): string {
  const brand = readBrandAssets(company);
  const colors = [
    brand?.primaryColor,
    brand?.secondaryColor,
    brand?.accentColor,
  ].filter((c): c is string => Boolean(c));
  if (colors.length === 0) return '';

  return [
    'BRAND PALETTE:',
    `- Build the image around these colours: ${colors.join(', ')}.`,
    '- They should dominate the composition — lighting, surfaces, background.',
    '- Do NOT render them as swatches, charts, or blocks of flat colour.',
  ].join('\n');
}

/**
 * Turn the stored brand voice profile into art direction.
 *
 * Tone descriptors ("candid", "precise", "warm") transfer to visuals well;
 * vocabulary and hashtag rules do not, so they are dropped. Topics the brand
 * avoids DO carry over — a company that never talks about a subject does not
 * want a picture of it either.
 */
function brandVoiceToVisualDirection(profile: unknown): string {
  const parsed = brandVoiceProfileSchema.safeParse(profile);
  if (!parsed.success) return '';
  const voice = parsed.data;

  const lines = ['BRAND CHARACTER (translate into visual mood, not text):'];
  if (voice.toneDescriptors.length) {
    lines.push(`- The brand reads as: ${voice.toneDescriptors.join(', ')}.`);
  }
  if (voice.summary) lines.push(`- In short: ${voice.summary}`);
  if (voice.topicsToAvoid.length) {
    lines.push(`- Never depict: ${voice.topicsToAvoid.join(', ')}.`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
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
): ImagePromptResult {
  const hook = firstMeaningfulLine(contentText);
  const subject = hook || 'the theme of this post';

  const prompt = [
    `A premium social-media graphic representing: ${subject}.`,
    'Interpret the idea visually as a single striking scene — a metaphor or a',
    'concrete situation, not an abstract pattern.',
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
