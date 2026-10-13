import { z } from 'zod';

import type { AspectRatioKey } from '@/lib/platforms';

/**
 * Marketing creatives: a real photograph with professional typography, the
 * brand's colours and logo, and the campaign's details — composed by Aura's
 * own layout renderer (server/media/creative), never typed by an image model.
 * Pure and client-safe.
 */

export const CREATIVE_VERSION = 1;

export const CREATIVE_TYPES = [
  'event',
  'product_launch',
  'promotion',
  'offer',
  'greeting',
  'announcement',
  'educational',
  'brand_awareness',
  'retail_promo',
  'b2b',
] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];

export const CREATIVE_TYPE_LABEL: Record<CreativeType, string> = {
  event: 'Event announcement',
  product_launch: 'Product launch',
  promotion: 'Promotional ad',
  offer: 'Special offer',
  greeting: 'Festival / holiday greeting',
  announcement: 'Business announcement',
  educational: 'Educational post',
  brand_awareness: 'Brand awareness',
  retail_promo: 'Restaurant / retail promotion',
  b2b: 'B2B marketing post',
};

export const LAYOUTS = [
  'hero',
  'split',
  'frame',
  'offer',
  'editorial',
  'spotlight',
] as const;
export type CreativeLayout = (typeof LAYOUTS)[number];

export const LAYOUT_LABEL: Record<CreativeLayout, string> = {
  hero: 'Full-bleed photo, headline over a gradient',
  split: 'Photo and a brand-colour panel',
  frame: 'Photo with a centred card',
  offer: 'Photo with an offer badge',
  editorial: 'Magazine style: headline above the photo',
  spotlight: 'Dramatic, centred, elegant type',
};

/** Layouts that suit each kind of creative, best first. Never one template for everything. */
export const TYPE_LAYOUTS: Record<CreativeType, CreativeLayout[]> = {
  event: ['hero', 'spotlight', 'split', 'frame'],
  product_launch: ['split', 'hero', 'editorial', 'spotlight'],
  promotion: ['hero', 'offer', 'split', 'frame'],
  offer: ['offer', 'hero', 'split'],
  greeting: ['spotlight', 'frame', 'hero'],
  announcement: ['frame', 'hero', 'split', 'editorial'],
  educational: ['editorial', 'split', 'frame'],
  brand_awareness: ['hero', 'editorial', 'frame', 'spotlight'],
  retail_promo: ['offer', 'hero', 'split', 'frame'],
  b2b: ['split', 'editorial', 'hero'],
};

/** Output sizes per format — social-ready pixels. */
export const CREATIVE_FORMATS: Record<
  AspectRatioKey,
  { width: number; height: number; label: string }
> = {
  '1:1': {
    width: 1080,
    height: 1080,
    label: 'Square · Instagram / Facebook / LinkedIn (1080×1080)',
  },
  '4:5': {
    width: 1080,
    height: 1350,
    label: 'Portrait · Instagram feed (1080×1350)',
  },
  '9:16': { width: 1080, height: 1920, label: 'Story / Reel (1080×1920)' },
  '16:9': {
    width: 1920,
    height: 1080,
    label: 'Landscape · LinkedIn / Facebook / X (1920×1080)',
  },
};

export const FONT_PAIRS = ['modern', 'impact', 'elegant', 'clean'] as const;
export type FontPair = (typeof FONT_PAIRS)[number];

export const FONT_PAIR_LABEL: Record<FontPair, string> = {
  modern: 'Modern bold (Montserrat)',
  impact: 'Impact condensed (Bebas Neue)',
  elegant: 'Elegant serif (Playfair Display)',
  clean: 'Clean sans (Inter)',
};

export const PHOTO_MOODS = ['natural', 'bright', 'moody', 'studio'] as const;
export type PhotoMood = (typeof PHOTO_MOODS)[number];
export const PHOTO_MOOD_LABEL: Record<PhotoMood, string> = {
  natural: 'Natural light',
  bright: 'Bright and airy',
  moody: 'Warm and moody',
  studio: 'Studio product shot',
};

const hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'Use a colour like #1A2B3C')
  .transform((v) => (v.startsWith('#') ? v : `#${v}`).toUpperCase());
const line = (max: number) => z.string().trim().max(max);

/**
 * What a person can set. Everything is optional — Aura fills the rest from the
 * post, the brief and the business — and anything set here is used exactly.
 */
export const creativeInputSchema = z.object({
  type: z.enum(CREATIVE_TYPES).optional(),
  layout: z.enum(LAYOUTS).optional(),
  aspectRatio: z.enum(['1:1', '4:5', '9:16', '16:9']).default('1:1'),
  fontPair: z.enum(FONT_PAIRS).optional(),
  mood: z.enum(PHOTO_MOODS).optional(),
  headline: line(80).optional(),
  subheadline: line(140).optional(),
  eyebrow: line(40).optional(),
  eventName: line(80).optional(),
  date: line(60).optional(),
  time: line(40).optional(),
  venue: line(100).optional(),
  offer: line(40).optional(),
  cta: line(30).optional(),
  website: line(80).optional(),
  showLogo: z.boolean().default(true),
  colors: z
    .object({ primary: hex.optional(), accent: hex.optional() })
    .default({}),
  /** A direction for the photograph ("a barista pouring latte art"). */
  photoDirection: line(300).optional(),
  /**
   * new — generate a new photograph; reuse — keep this photo (edit text and
   * layout without spending a generation); none — brand background only.
   */
  photo: z.enum(['new', 'reuse', 'none']).default('new'),
  photoAssetId: z.string().max(64).optional(),
});
export type CreativeInput = z.infer<typeof creativeInputSchema>;
export type CreativeInputRaw = z.input<typeof creativeInputSchema>;

const nullable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

/** The creative's words as they will be set — kept when only the photo or layout changes. */
export const creativeTextSchema = z.object({
  eyebrow: nullable(40),
  headline: z.string().trim().min(1, 'A creative needs a headline.').max(80),
  subheadline: nullable(140),
  date: nullable(60),
  time: nullable(40),
  venue: nullable(100),
  offer: nullable(40),
  cta: nullable(30),
  website: nullable(80),
});

export const keepTextSchema = z.object({
  type: z.enum(CREATIVE_TYPES),
  text: creativeTextSchema,
  sources: z
    .record(z.enum(['you', 'your request', 'your post', 'business', 'aura']))
    .default({}),
});

export const TEXT_FIELDS = [
  'eyebrow',
  'headline',
  'subheadline',
  'date',
  'time',
  'venue',
  'offer',
  'cta',
  'website',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** Where each piece of text came from — shown to the reviewer. */
export type TextSource =
  'you' | 'your request' | 'your post' | 'business' | 'aura';

export interface CreativeText {
  eyebrow: string | null;
  headline: string;
  subheadline: string | null;
  date: string | null;
  time: string | null;
  venue: string | null;
  offer: string | null;
  cta: string | null;
  website: string | null;
}

/** A fully resolved creative — what is rendered, and stored with the image. */
export interface CreativeSpec {
  version: typeof CREATIVE_VERSION;
  type: CreativeType;
  layout: CreativeLayout;
  aspectRatio: AspectRatioKey;
  fontPair: FontPair;
  mood: PhotoMood;
  text: CreativeText;
  sources: Partial<Record<TextField, TextSource>>;
  brand: {
    name: string;
    colors: BrandPalette;
    logoAssetId: string | null;
    logoUrl: string | null;
    showLogo: boolean;
  };
  photo: {
    assetId: string | null;
    prompt: string | null;
    direction: string | null;
    /** No AI photograph: a brand-colour background, labelled as such. */
    fallback: boolean;
    fallbackReason: string | null;
  };
}

// ---------------------------------------------------------------------------
// Choosing the design
// ---------------------------------------------------------------------------

const TYPE_SIGNALS: [CreativeType, RegExp][] = [
  [
    'greeting',
    /\b(happy (diwali|holi|new year|eid|navratri|pongal|onam|easter|holidays|thanksgiving|hanukkah|lunar new year)|merry christmas|season'?s greetings|festive greetings|eid mubarak|diwali|christmas|ramadan|festival of lights)\b/i,
  ],
  [
    'offer',
    /(\b\d{1,2}\s?% off\b|\bdiscount|\bcoupon|\bpromo code|\bbogo\b|\bbuy one\b|\bhalf price|\bflash sale|\bclearance|\bsave \d|\bspecial offer|\blimited[- ]time offer)/i,
  ],
  [
    'event',
    /\b(summit|conference|webinar|workshop|meetup|meet-up|expo|gala|seminar|masterclass|tasting|festival|launch event|open house|hackathon|register|rsvp|join us (on|at|for))\b/i,
  ],
  [
    'product_launch',
    /\b(introducing|now available|just launched|launching|new (product|collection|range|arrival|flavour|flavor|menu)|meet the new|pre-?order)\b/i,
  ],
  [
    'retail_promo',
    /\b(in[- ]store|shop now|order now|dine[- ]in|takeaway|menu|our (store|shop|restaurant|cafe|café)|happy hour|brunch|today'?s special)\b/i,
  ],
  [
    'educational',
    /\b(tips?|how to|guide|did you know|ways to|lessons?|mistakes|checklist|explained|myths?|faq)\b/i,
  ],
  [
    'announcement',
    /\b(announc|we'?re (excited|thrilled|proud)|now open|grand opening|welcome|partnership|partnered|milestone|anniversary|award|new (office|location|branch))/i,
  ],
  [
    'promotion',
    /\b(sale|deal|limited time|exclusive|this week only|while stocks last)\b/i,
  ],
];

/** The kind of creative a piece of text calls for. */
export function detectCreativeType(text: string, b2b: boolean): CreativeType {
  for (const [type, re] of TYPE_SIGNALS) if (re.test(text)) return type;
  return b2b ? 'b2b' : 'brand_awareness';
}

/** A layout that suits the type — the offer badge only when there is an offer. */
export function chooseLayout(
  type: CreativeType,
  opts: { hasOffer: boolean; variant?: number },
): CreativeLayout {
  const options = TYPE_LAYOUTS[type].filter(
    (l) => l !== 'offer' || opts.hasOffer,
  );
  const list = options.length ? options : ['hero' as const];
  return list[(opts.variant ?? 0) % list.length]!;
}

export function chooseFontPair(type: CreativeType, tone: string[]): FontPair {
  const t = tone.join(' ').toLowerCase();
  if (/(elegant|luxur|premium|refined|sophisticat|classic|timeless)/.test(t))
    return 'elegant';
  if (/(bold|energetic|playful|fun|loud|vibrant|youthful)/.test(t))
    return 'impact';
  if (type === 'greeting') return 'elegant';
  if (type === 'offer' || type === 'retail_promo') return 'impact';
  if (type === 'b2b' || type === 'educational') return 'clean';
  return 'modern';
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
}

/** A dependable palette when the business has not set its colours. */
export const DEFAULT_PALETTE: BrandPalette = {
  primary: '#14213D',
  secondary: '#1F3A5F',
  accent: '#F5B700',
};

export function normalizeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!m) return null;
  const h =
    m[1]!.length === 3
      ? m[1]!
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]!;
  return `#${h.toUpperCase()}`;
}

const rgb = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
const toHex = (c: number[]) =>
  `#${c
    .map((x) =>
      Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;

export function luminance(h: string): number {
  const [r, g, b] = rgb(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [
    number,
    number,
  ];
  return (x + 0.05) / (y + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const [p, q] = [rgb(a), rgb(b)];
  return toHex(p.map((v, i) => v + (q[i]! - v) * t));
}

export const INK = '#111827';
export const PAPER = '#FFFFFF';

/** The more readable of white and near-black on a background. */
export function textOn(bg: string): string {
  return contrast(bg, PAPER) >= contrast(bg, INK) ? PAPER : INK;
}

/** A shade of the colour dark enough to carry white text (contrast ≥ 4.5). */
export function deepen(color: string): string {
  let c = color;
  for (let i = 0; i < 12 && contrast(c, PAPER) < 4.5; i++)
    c = mix(c, '#000000', 0.12);
  return c;
}

/** The brand's palette, completed and checked. */
export function brandPalette(colors: {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
}): BrandPalette {
  const primary = normalizeHex(colors.primary) ?? DEFAULT_PALETTE.primary;
  const secondary =
    normalizeHex(colors.secondary) ?? mix(primary, '#000000', 0.25);
  let accent = normalizeHex(colors.accent);
  // An accent too close to the primary would vanish against it.
  if (!accent || contrast(accent, primary) < 1.6) {
    accent =
      contrast(DEFAULT_PALETTE.accent, primary) >= 1.6
        ? DEFAULT_PALETTE.accent
        : '#FFFFFF';
  }
  return { primary, secondary, accent };
}

// ---------------------------------------------------------------------------
// Facts: never invent
// ---------------------------------------------------------------------------

/** The figures in a text: numbers, percentages, prices, years. */
export function figuresIn(text: string): string[] {
  return (text.match(/[$€£₹¥]?\s?\d[\d,.:]*\s?%?/g) ?? [])
    .map((f) => f.replace(/[\s,]/g, '').replace(/[.:]$/, ''))
    .filter(Boolean);
}

/** Every figure in `text` appears in the trusted sources. */
export function figuresBacked(text: string, sources: string): boolean {
  const have = new Set(
    figuresIn(sources).map((f) => f.replace(/^[$€£₹¥]/, '').replace(/%$/, '')),
  );
  return figuresIn(text).every((f) =>
    have.has(f.replace(/^[$€£₹¥]/, '').replace(/%$/, '')),
  );
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'at',
  'on',
  'in',
  'of',
  'and',
  'to',
  'for',
  'our',
  'your',
  'with',
  'from',
  '&',
]);

/**
 * A detail (date, venue, offer) is used only when the person gave it: every
 * figure and most of its words appear in what they wrote.
 */
export function detailBacked(value: string, userText: string): boolean {
  if (!figuresBacked(value, userText)) return false;
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  if (!words.length) return figuresIn(value).length > 0;
  const src = userText.toLowerCase();
  const found = words.filter(
    (w) => src.includes(w) || src.includes(w.slice(0, 3)),
  );
  return found.length / words.length >= 0.75;
}
