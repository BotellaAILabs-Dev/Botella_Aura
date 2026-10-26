import type {
  CreativeLayout,
  CreativeType,
  PhotoMood,
} from '@/lib/creative/spec';
import {
  PEOPLE_DIRECTION,
  PEOPLE_REALISM_SHORT,
  REALISM_DIRECTION,
  photoNegativeFor,
  shotKindOf,
  type ShotKind,
} from '@/lib/photo-realism';

/**
 * The brief for a creative's photograph: commercial photography of the right
 * scene for the business, framed so the layout's text has calm space to sit
 * in — with no text, logos or illustration in the image itself. Pure.
 */

export interface PhotoPromptInput {
  type: CreativeType;
  layout: CreativeLayout;
  aspectRatio: string;
  mood: PhotoMood;
  business: {
    name: string;
    industry: string | null;
    offerings: string | null;
    description: string | null;
  };
  /** What the photo should show — from the art director, the user, or the post. */
  scene: string | null;
  /** The person's own direction, used as given. */
  direction: string | null;
  consumer: boolean;
}

/** A sensible scene when nothing better is known. */
const TYPE_SCENE: Record<
  CreativeType,
  (b: PhotoPromptInput['business'], consumer: boolean) => string
> = {
  event: (b) =>
    `a real ${b.industry ?? 'business'} event in a modern venue: a stage with warm spotlights, an engaged audience seen from behind, candid and lively`,
  product_launch: (b) =>
    `a hero product shot of ${b.offerings ?? `the ${b.industry ?? 'company'}'s product`} on a styled surface with complementary props, seamless backdrop`,
  promotion: (b, consumer) =>
    consumer
      ? `people enjoying ${b.offerings ?? 'the product'} in an authentic lifestyle setting`
      : `a professional using ${b.offerings ?? 'the service'} in a bright modern workplace`,
  offer: (b) =>
    `an inviting display of ${b.offerings ?? 'the products'}, beautifully arranged and well lit, ready to buy`,
  greeting: () =>
    'a warm festive scene with soft bokeh lights and tasteful seasonal décor, inviting and celebratory',
  announcement: (b) =>
    `the ${b.industry ?? 'company'}'s premises: a welcoming storefront or modern office interior, bright and inviting`,
  educational: (b) =>
    `hands-on, authentic work in ${b.industry ?? 'the field'}: a close, natural moment that shows the craft`,
  brand_awareness: (b, consumer) =>
    consumer
      ? `real customers enjoying ${b.offerings ?? 'what the business offers'} in a natural, aspirational setting`
      : `a confident team at work in a modern, light-filled office`,
  retail_promo: (b) =>
    `the inside of a beautiful ${b.industry ?? 'shop'}: ${b.offerings ?? 'products'} on display, warm ambient light, inviting atmosphere`,
  b2b: () =>
    'professionals collaborating around a table in a modern glass-walled office, natural window light',
};

const MOOD: Record<PhotoMood, string> = {
  natural: 'soft natural daylight, true-to-life colour',
  bright: 'bright, airy, high-key light, clean whites and gentle shadows',
  moody: 'warm, low-key light with rich shadows and a cinematic colour grade',
  studio:
    'controlled studio lighting with a softbox key and subtle rim light, seamless backdrop',
};

/** Where the layout puts its text — that part of the frame must stay calm. */
const SPACE: Record<CreativeLayout, string> = {
  hero: 'Keep the lower 40% of the frame visually calm and uncluttered (soft, out-of-focus or plain surfaces) — text will be placed there.',
  offer:
    'Keep the lower half and the top-right corner uncluttered — text and a badge will be placed there.',
  split:
    'Centre the subject with breathing room on every side; nothing important at the edges.',
  frame:
    'Keep the centre of the frame simple and evenly lit; interesting detail toward the edges.',
  editorial:
    'Centre the subject with clean surroundings; it will be shown in a framed panel.',
  spotlight:
    'An atmospheric scene with a calm, darker centre — text will be placed across the middle.',
};

const LANDSCAPE_SPACE =
  'Keep the left half of the frame calm and uncluttered — text will be placed there; the subject sits right of centre.';

/**
 * Generated-image tells (lib/photo-realism.ts) and anything written.
 *
 * The default for a creative whose shot is not known. Prefer
 * photoNegativeFor(kind) via buildPhotoPrompt, which keeps the terms that
 * matter for the shot actually being taken — the negative prompt is capped, so
 * which terms come first decides which ones survive at all.
 */
export const PHOTO_NEGATIVE = photoNegativeFor('people');

export function buildPhotoPrompt(i: PhotoPromptInput): {
  prompt: string;
  negativePrompt: string;
} {
  const landscape = i.aspectRatio === '16:9';
  const lens =
    i.type === 'product_launch' || i.mood === 'studio'
      ? 'Shot on a full-frame camera with a 100mm macro lens, f/8, crisp detail on the product.'
      : i.type === 'event' || i.type === 'b2b'
        ? 'Shot on a full-frame camera with a 35mm lens, f/2.8, natural perspective.'
        : 'Shot on a full-frame camera with a 50mm lens, f/2, shallow depth of field.';
  const rules = [
    landscape ? LANDSCAPE_SPACE : SPACE[i.layout],
    'Absolutely no text, letters, logos, signage or watermarks anywhere in the image.',
  ].join(' ');
  const lead = `Professional commercial photograph for ${i.business.name}${i.business.industry ? `, a ${i.business.industry} business` : ''}: `;
  // Within 1,500 characters: the light, lens, realism, where the text goes
  // and the no-text rule always reach the model; the scene is clipped to the
  // room that leaves, and the extra quality line is added only if it fits.
  const fixed = [`Lighting: ${MOOD[i.mood]}.`, lens];
  const after = [REALISM_DIRECTION, PEOPLE_DIRECTION, rules];
  const extra =
    'Photorealistic, editorial advertising quality: realistic textures and materials, accurate proportions, natural skin, true-to-life colour grading, sharp focus on the subject.';
  // What kind of shot this is, from the creative's type and the scene as
  // written — read BEFORE the scene is clipped, so the budget below can
  // account for the people brief. Reading it after would be circular: the
  // clip length would depend on a brief that depends on the clipped text.
  const wanted =
    i.direction?.trim() ||
    i.scene?.trim() ||
    TYPE_SCENE[i.type](i.business, i.consumer);
  const kind = shotKindFor(i, wanted);
  const withPeople = kind === 'people' || kind === 'event';
  // Where there are people to get wrong, say what a real one looks like.
  const people = withPeople ? [PEOPLE_REALISM_SHORT] : [];
  // The reserved length must cover everything that will be in the prompt.
  // It did not count the people brief, so an `event` creative overshot 1,500
  // by three characters and silently lost its quality line instead.
  const reserved =
    [lead, ...fixed, extra, ...people, ...after].join(' ').length + 2;
  const scene = clip(wanted, Math.min(500, 1500 - reserved)).replace(
    /[.\s]+$/,
    '',
  );
  const core = [`${lead}${scene}.`, ...fixed];
  const withExtra = [...core, extra, ...people, ...after].join(' ');
  const prompt =
    withExtra.length <= 1500
      ? withExtra
      : // Drop the generic quality line before the people brief: it repeats
        // what REALISM_DIRECTION already says, and the people brief does not.
        (() => {
          const withoutExtra = [...core, ...people, ...after].join(' ');
          return withoutExtra.length <= 1500
            ? withoutExtra
            : [...core, ...after].join(' ');
        })();
  return { prompt, negativePrompt: photoNegativeFor(kind) };
}

/**
 * The shot a creative is taking. The creative's own type is the better signal
 * (an `offer` is a product display however its scene reads), and the scene
 * text decides the cases where the type does not say — a `promotion` is people
 * for a consumer brand and a workplace for a B2B one.
 */
function shotKindFor(i: PhotoPromptInput, scene: string): ShotKind {
  if (i.type === 'event') return 'event';
  if (i.type === 'product_launch' || i.type === 'offer') return 'product';
  if (i.type === 'announcement') return 'place';
  return shotKindOf(scene);
}

/** At most `max` characters, on a word boundary. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max * 0.6 ? cut.slice(0, space) : cut;
}
