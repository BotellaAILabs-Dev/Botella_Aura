import type {
  CreativeLayout,
  CreativeType,
  PhotoMood,
} from '@/lib/creative/spec';

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

export const PHOTO_NEGATIVE =
  'text, letters, words, typography, captions, logos, watermarks, signage with writing, illustration, cartoon, painting, drawing, 3D render, CGI, plastic skin, distorted hands, extra fingers, deformed faces, warped products, blurry subject, oversaturated colours, collage, frame, border';

export function buildPhotoPrompt(i: PhotoPromptInput): {
  prompt: string;
  negativePrompt: string;
} {
  const scene = (
    i.direction?.trim() ||
    i.scene?.trim() ||
    TYPE_SCENE[i.type](i.business, i.consumer)
  ).replace(/[.\s]+$/, '');
  const landscape = i.aspectRatio === '16:9';
  const lens =
    i.type === 'product_launch' || i.mood === 'studio'
      ? 'Shot on a full-frame camera with a 100mm macro lens, f/8, crisp detail on the product.'
      : i.type === 'event' || i.type === 'b2b'
        ? 'Shot on a full-frame camera with a 35mm lens, f/2.8, natural perspective.'
        : 'Shot on a full-frame camera with a 50mm lens, f/2, shallow depth of field.';
  const prompt = [
    `Professional commercial photograph for ${i.business.name}${i.business.industry ? `, a ${i.business.industry} business` : ''}: ${scene}.`,
    `Lighting: ${MOOD[i.mood]}.`,
    lens,
    'Photorealistic, editorial advertising quality: realistic textures and materials, accurate proportions, natural skin, true-to-life colour grading, sharp focus on the subject.',
    'Any people are anonymous, natural and diverse — no celebrities.',
    landscape ? LANDSCAPE_SPACE : SPACE[i.layout],
    'Absolutely no text, letters, logos, signage or watermarks anywhere in the image.',
  ].join(' ');
  return { prompt: prompt.slice(0, 1500), negativePrompt: PHOTO_NEGATIVE };
}
