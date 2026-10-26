import type { ImageStyleKey } from '@/lib/graphics-ui';
import type { SocialPlatformKey } from '@/lib/platforms';

/**
 * PHOTO REALISM — what makes a generated marketing image read as a real
 * photograph rather than "AI art", shared by every image path in Content
 * Studio (the graphic studio's prompt, the marketing creatives' photo, and the
 * free-text image generator).
 *
 * Image models drift toward the same tells: glossy over-polished surfaces,
 * waxy skin, perfect symmetry, HDR glow, floating objects, posed stock-photo
 * smiles, concept-art "metaphors". The remedy is the language a photographer's
 * brief uses — a real place, a real moment, a named camera and light source,
 * real materials with their imperfections — plus naming the tells to avoid.
 *
 * Pure and client-safe.
 */

/** Styles that are photographs; the rest (minimal, 3D, illustration) are not. */
export const PHOTOGRAPHIC_STYLES: readonly ImageStyleKey[] = [
  'photo',
  'professional',
  'cinematic',
];

export function isPhotographic(style: ImageStyleKey): boolean {
  return PHOTOGRAPHIC_STYLES.includes(style);
}

/** How a real photograph looks, in a photographer's terms. */
export const REALISM_DIRECTION =
  'Indistinguishable from a real photograph taken on location by a professional photographer: ' +
  'one consistent, natural light source; real materials with fine texture and small imperfections ' +
  '(fabric weave, wood grain, skin pores, slight wear); believable background detail; ' +
  'true-to-life colour, a subtle grade, natural depth of field. Not glossy or over-polished. ' +
  // Image models letter every surface they can, and always badly.
  'Any sign, menu, label, packaging, badge or screen is blank, turned away or out of focus.';

/** People that look like customers and staff, not stock models or celebrities. */
export const PEOPLE_DIRECTION =
  'People look like real, anonymous customers or staff: candid and unposed, natural expressions, ' +
  'realistic skin and hands, everyday clothing — never celebrities, public figures or stock-photo grins.';

/**
 * What a generated person gets wrong, in a photographer's terms.
 *
 * Added because images without people were reading as real and images with
 * people were not. Faces are where image models are weakest and where a viewer
 * is most practised at spotting a fake, so a generic "photorealistic" is not
 * enough: this names the specific failures — the symmetrical face, the
 * pore-less skin, the held smile, the hands — and asks for the specific
 * imperfections a real photograph of a real person always has.
 *
 * Used in addition to PEOPLE_DIRECTION, and only when there are people in
 * frame — it is a long brief, and it is wasted on a product shot.
 */
export const PEOPLE_REALISM =
  'The people must look photographed, not generated: ordinary asymmetric faces, ' +
  'not model-like; visible skin texture — pores, fine lines, uneven tone — never ' +
  'smoothed or waxy; hands correct, with five fingers, doing something specific; ' +
  'unforced expressions caught mid-moment, not a held grin to camera; clothes ' +
  'creased as worn; believable proportions with contact shadows.';

/**
 * The same brief, short enough to fold into a composed image prompt.
 *
 * An image prompt is capped at 1,500 characters and the realism, camera,
 * platform and no-text direction already fill most of it. The full brief above
 * is for the art-director MODEL, which has room; this is what goes straight
 * into a prompt, where every clause displaces something else that matters.
 * Trimmed to the three tells a viewer actually notices: the skin, the hands,
 * and the held smile.
 */
export const PEOPLE_REALISM_SHORT =
  'Real photographed people: textured skin with pores and uneven tone (never ' +
  'smoothed or waxy), correct five-fingered hands, unforced candid expressions.';

/** Anatomy and skin: the failures a viewer spots first on a generated person. */
export const PEOPLE_NEGATIVE = [
  'distorted hands',
  'extra fingers',
  'missing fingers',
  'fused fingers',
  'deformed faces',
  'asymmetric eyes',
  'dead eyes',
  'plastic or waxy skin',
  'airbrushed',
  'over-smoothed',
  'posed stock smiles',
  'mannequin',
  'uncanny valley',
  'identical faces',
].join(', ');

/** The tells of a generated image, for the negative prompt. */
export const AI_LOOK_NEGATIVE = [
  'AI-generated look',
  'CGI',
  '3D render',
  'digital art',
  'illustration',
  'cartoon',
  'painting',
  'plastic or waxy skin',
  'airbrushed',
  'over-smoothed',
  'HDR glow',
  'oversaturated colours',
  'neon haze',
  'surreal',
  'floating objects',
  'impossible reflections',
  'perfect symmetry',
  'generic stock photo',
  'posed stock smiles',
  'distorted hands',
  'extra fingers',
  'deformed faces',
  'warped products',
  'blurry subject',
].join(', ');

/** Never in the image, whatever the style: the post and layout carry the words. */
export const NO_TEXT_NEGATIVE =
  'text, letters, words, typography, captions, logos, watermarks, signage with writing, menu boards with writing, labels with writing, name badges, collage, frame, border';

/**
 * The text terms that must survive at any budget.
 *
 * NO_TEXT_NEGATIVE spells out every surface a model might letter, which is
 * useful and long. Negative prompts are capped (NEGATIVE_MAX), and that list
 * sitting at the front used to consume the entire budget — so the terms after
 * it were dropped in silence. These few carry almost all of its value; the
 * rest are added later, if there is room.
 */
const TEXT_NEGATIVE_CORE =
  'text, letters, words, typography, watermarks, logos, signage with writing';

/**
 * The photographic register each network rewards. The platforms' own art
 * direction (lib/platforms.ts) is written for graphics; this is its
 * photographic counterpart.
 */
export const PLATFORM_PHOTO_DIRECTION: Record<SocialPlatformKey, string> = {
  LINKEDIN:
    'LinkedIn: authentic documentary-style business photography — real workplaces, real work in progress, credible professionals; understated and trustworthy, natural window light.',
  INSTAGRAM:
    'Instagram: aspirational lifestyle or product photography with an editorial magazine feel — one strong focal point that survives a square crop, rich but natural colour.',
  FACEBOOK:
    'Facebook: warm, approachable community photography — real customers and staff in genuine moments, friendly natural light, everyday authenticity.',
  X: 'X: one clear, high-contrast photographic subject on an uncluttered background, readable at the small size of a timeline card.',
};

export type ShotKind = 'product' | 'people' | 'place' | 'event';

/** Camera, lens and aperture a photographer would choose for the shot. */
export function cameraFor(kind: ShotKind): string {
  switch (kind) {
    case 'product':
      return 'Shot on a full-frame camera with a 100mm macro lens at f/8, crisp detail on the product.';
    case 'event':
      return 'Shot on a full-frame camera with a 35mm lens at f/2.8, natural perspective, candid.';
    case 'place':
      return 'Shot on a full-frame camera with a 24–35mm lens at f/4, level verticals, true perspective.';
    case 'people':
    default:
      return 'Shot on a full-frame camera with a 50mm lens at f/2, shallow depth of field.';
  }
}

/** The likeliest kind of shot for a scene, from its words. */
export function shotKindOf(scene: string): ShotKind {
  const s = scene.toLowerCase();
  if (
    /\b(event|stage|conference|summit|audience|crowd|festival|launch party)\b/.test(
      s,
    )
  )
    return 'event';
  if (
    /\b(people|person|customer|team|staff|barista|chef|colleague|professional|family|friends|woman|man|hands?)\b/.test(
      s,
    )
  )
    return 'people';
  if (
    /\b(store|shop|storefront|office|interior|venue|restaurant|cafe|café|showroom|premises)\b/.test(
      s,
    )
  )
    return 'place';
  if (
    /\b(product|bottle|package|packaging|dish|plate|device|shelf|display)\b/.test(
      s,
    )
  )
    return 'product';
  return 'people';
}

/** Whoever wrote this prompt asked for something other than a photograph. */
export function asksForNonPhoto(prompt: string): boolean {
  return /\b(illustrat\w*|cartoon|anime|vector|3d render|cgi|watercolou?r|oil painting|painting|sketch|line art|clip ?art|pixel art|isometric|flat design|logo design|icon)\b/i.test(
    prompt,
  );
}

/**
 * A free-text prompt made photographic: the person's words first, then the
 * realism direction. A prompt that asks for an illustration (or any other
 * non-photo style) is left exactly as written.
 */
export function withPhotoRealism(prompt: string): {
  prompt: string;
  negativePrompt: string | null;
} {
  const p = prompt.trim();
  if (asksForNonPhoto(p)) return { prompt: p, negativePrompt: null };
  const kind = shotKindOf(p);
  const withPeople = kind === 'people' || kind === 'event';
  return {
    prompt: [
      p.replace(/[.\s]+$/, '') + '.',
      `Professional marketing photograph. ${cameraFor(kind)}`,
      REALISM_DIRECTION,
      PEOPLE_DIRECTION,
      // Only where there are people to get wrong, and in the short form —
      // this is a composed prompt against a hard character limit.
      withPeople ? PEOPLE_REALISM_SHORT : '',
      'No text, letters, logos or watermarks in the image.',
    ]
      .filter(Boolean)
      .join(' '),
    negativePrompt: photoNegativeFor(kind),
  };
}

/** The longest negative prompt the image pipeline stores (lib/validations/media.ts). */
export const NEGATIVE_MAX = 400;

/**
 * The negative prompt for a photograph, ordered for the shot being taken.
 *
 * This exists because of a silent, specific bug. The negative prompt was built
 * as mergeNegative(NO_TEXT_NEGATIVE, AI_LOOK_NEGATIVE) and capped at 400
 * characters — and the text list is long enough that the last eight terms of
 * the second list never fitted. Those terms were: perfect symmetry, generic
 * stock photo, posed stock smiles, distorted hands, extra fingers, deformed
 * faces, warped products, blurry subject.
 *
 * So every photograph was generated with no defence against exactly the
 * failures people were reporting — hands, faces and stock-photo smiles — while
 * the code read as though it had them. Nothing errored; the terms were dropped
 * on the floor by a budget check.
 *
 * The cap stays (a stored negative prompt is replayed through a 400-character
 * request schema by "Another image", so a longer one would break that round
 * trip). What changes is the order: a few text terms that carry most of the
 * text rule, then the terms that matter for THIS shot, then the rest as
 * filler. A product shot keeps its warped-product term; a shot with people
 * keeps its hands and faces.
 */
export function photoNegativeFor(kind: ShotKind): string {
  const priority =
    kind === 'people' || kind === 'event'
      ? [PEOPLE_NEGATIVE, AI_LOOK_NEGATIVE]
      : kind === 'product'
        ? ['warped products, impossible reflections, floating objects, blurry subject', AI_LOOK_NEGATIVE]
        : ['impossible geometry, warped perspective, floating objects, blurry subject', AI_LOOK_NEGATIVE];
  return mergeNegative(TEXT_NEGATIVE_CORE, ...priority, NO_TEXT_NEGATIVE);
}

/**
 * Comma-separated lists as one, in order, without repeats, within
 * NEGATIVE_MAX — whole terms only; one that does not fit is skipped, never
 * cut. Put what matters most first.
 */
export function mergeNegative(...lists: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of lists
    .join(',')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    if ([...out, term].join(', ').length > NEGATIVE_MAX) continue;
    seen.add(k);
    out.push(term);
  }
  return out.join(', ');
}
