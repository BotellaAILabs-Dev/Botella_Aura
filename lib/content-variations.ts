import {
  CONTENT_TONES,
  type ContentTone,
  type ContentTypeKey,
} from '@/lib/validations/content';
import {
  platformSpec,
  platformsForType,
  type SocialPlatformKey,
} from '@/lib/platforms';

/**
 * CONTENT VARIATIONS — another version of a draft, made on request, kept next
 * to the original instead of replacing it.
 *
 *   shorter · longer · tone      the whole piece, rewritten
 *   cta · headline               ONE field rewritten; the rest of the piece is
 *                                kept byte for byte (enforced in code, not asked)
 *   channel                      the same piece shaped for another network the
 *                                format runs on
 *   image                        another picture from the same visual brief
 *
 * GUARDRAIL. A variation keeps the original's goal, audience, core facts,
 * evidence and brand requirements. The writer is told exactly what to keep
 * (preserveInstructions), and the result is checked: any number, price, date,
 * link, address or handle that is in neither the original nor the brief is a
 * changed fact (findIntroducedFacts). It is sent back once to be corrected;
 * if it still carries one, the version is kept but blocked from approval with
 * the facts named. Facts are never changed to make a version different.
 *
 * Every version is stored on its own (the draft's `variations`), with what it
 * is, when it was made and what it was made from, so each can be read and
 * chosen separately; choosing one is undoable.
 *
 * Pure and client-safe.
 */

export const VARIATION_KINDS = [
  'shorter',
  'longer',
  'tone',
  'cta',
  'headline',
  'channel',
  'image',
] as const;
export type VariationKind = (typeof VARIATION_KINDS)[number];

export const VARIATION_LABELS: Record<VariationKind, string> = {
  shorter: 'Shorter',
  longer: 'Longer',
  tone: 'Different tone',
  cta: 'Alternative CTA',
  headline: 'Alternative headline',
  channel: 'For another channel',
  image: 'Another image',
};

/** The one field "Alternative headline" rewrites, per format (null: none to rewrite). */
export const HEADLINE_FIELD: Record<ContentTypeKey, string | null> = {
  LINKEDIN_POST: 'hook',
  IMAGE_POST: null,
  CAROUSEL: 'title',
  TWEET_THREAD: null,
  BLOG: 'headline',
  EMAIL: 'subjectLine',
  AD: 'headline',
  CAMPAIGN_COPY: 'tagline',
  PROMO: 'headline',
};

/** Limits for the single field, matching the format's schema. */
const FIELD_MAX: Record<string, number> = {
  hook: 300,
  title: 160,
  headline: 80,
  subjectLine: 120,
  tagline: 80,
  cta: 300,
};

/** What can be asked for on this format — and, when not, why. */
export function availableVariations(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): {
  kind: VariationKind;
  label: string;
  available: boolean;
  reason: string | null;
  platforms?: SocialPlatformKey[];
  tones?: readonly ContentTone[];
}[] {
  const otherNetworks = platformsForType(type).filter((p) => p !== platform);
  const hasCta = type !== 'TWEET_THREAD';
  const headline = HEADLINE_FIELD[type];
  return VARIATION_KINDS.map((kind) => {
    const base = { kind, label: VARIATION_LABELS[kind] };
    switch (kind) {
      case 'tone':
        return { ...base, available: true, reason: null, tones: CONTENT_TONES };
      case 'cta':
        return hasCta
          ? { ...base, available: true, reason: null }
          : {
              ...base,
              available: false,
              reason:
                'A thread carries its call to action inside the last post — use Shorter or Different tone.',
            };
      case 'headline':
        return headline
          ? { ...base, available: true, reason: null }
          : {
              ...base,
              available: false,
              reason: 'This format has no separate headline.',
            };
      case 'channel':
        return otherNetworks.length
          ? { ...base, available: true, reason: null, platforms: otherNetworks }
          : {
              ...base,
              available: false,
              reason: 'This format runs on one channel only.',
            };
      case 'image':
        return type === 'TWEET_THREAD' || type === 'CAMPAIGN_COPY'
          ? { ...base, available: false, reason: 'This format takes no image.' }
          : { ...base, available: true, reason: null };
      default:
        return { ...base, available: true, reason: null };
    }
  });
}

/** What the writer is asked to do, per kind. */
export function variationInstruction(
  kind: Exclude<VariationKind, 'image'>,
  opts: {
    toneGuidance?: string;
    platform?: SocialPlatformKey | null;
    field?: string | null;
  } = {},
): string {
  switch (kind) {
    case 'shorter':
      return 'Write a SHORTER version — about 40% fewer words. Keep the hook, the key message and the call to action; cut supporting detail, never facts that are kept.';
    case 'longer':
      return 'Write a LONGER version — add depth using only the facts, evidence and context provided (an example, a reason, a consequence). Stay within the format’s length limit. Add no new numbers, prices, dates or claims.';
    case 'tone':
      return `Rewrite it in a different tone, keeping the facts, structure and call to action: ${opts.toneGuidance ?? ''}`.trim();
    case 'channel':
      return `Rewrite it for ${opts.platform ? platformSpec(opts.platform).label : 'the other channel'}, following that network’s rules above. Same message, same facts, same call to action — shaped for where it now runs.`;
    case 'cta':
      return `Write ONE alternative for the \`${opts.field ?? 'cta'}\` field — a different way to ask for the same action, to the same destination. Return only that field’s new text.`;
    case 'headline':
      return `Write ONE alternative for the \`${opts.field ?? 'headline'}\` field — a different angle on the same message. Return only that field’s new text.`;
  }
}

export interface PreserveContext {
  goal: string | null;
  audience: string | null;
  keyMessage: string | null;
  evidence: string[];
  ctaDestination: string | null;
  /** Brand: topics never mentioned, voice summary. */
  avoid: string[];
  voice: string | null;
  /** Facts in the current version (numbers, prices, dates, links, handles). */
  facts: string[];
}

/** The guardrail, as the writer reads it. */
export function preserveInstructions(p: PreserveContext): string {
  return [
    'KEEP EXACTLY (this is a variation, not a new piece):',
    p.goal ? `- Goal: ${p.goal}` : '',
    p.audience ? `- Audience: ${p.audience}` : '',
    p.keyMessage ? `- Key message: ${p.keyMessage}` : '',
    p.evidence.length
      ? `- Evidence (the only claims allowed): ${p.evidence.join('; ')}`
      : '- Evidence: none — make no claims beyond the current version.',
    p.ctaDestination
      ? `- Where the call to action sends people: ${p.ctaDestination}`
      : '',
    p.voice ? `- Brand voice: ${p.voice}` : '',
    p.avoid.length ? `- Never mention: ${p.avoid.join(', ')}` : '',
    p.facts.length
      ? `- These facts, unchanged wherever they appear: ${p.facts.join(' · ')}`
      : '- The facts in the current version, unchanged.',
    '- Do NOT change, round or invent any number, price, percentage, date, name, link or claim to make the version different. Change the wording, not the facts.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const FACT_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)\]}"'<>]+/gi, // links
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // email addresses
  /(?<![\w])@[A-Za-z0-9_]{2,}/g, // handles
  /[$£€₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion))?/gi, // money
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b)/gi, // percentages
  /\b(?:\d{1,2}\s)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s\d{1,2})?(?:,?\s\d{4})?\b/gi, // dates
  /\b\d[\d,]*(?:\.\d+)?\b/g, // any other number
];

const normalise = (f: string) =>
  f
    .toLowerCase()
    .replace(/[.,;:!?)]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/$/, '')
    .trim();

/** The checkable facts in a text: numbers, money, percentages, dates, links, emails, handles. */
export function extractFacts(text: string): string[] {
  const found = new Set<string>();
  let rest = text;
  for (const re of FACT_PATTERNS) {
    rest = rest.replace(re, (m) => {
      const n = normalise(m);
      // Bare small numbers ("3 tips", "1 thing") are wording, not facts.
      if (/^\d{1,2}$/.test(n) && !/[%$£€₹]/.test(m)) return ' ';
      if (n.length > 0) found.add(n);
      return ' ';
    });
  }
  return [...found];
}

/**
 * Facts in the variation that are in neither the original nor the brief —
 * i.e. changed or invented. A shorter version may DROP facts; it may not
 * introduce or alter one.
 */
export function findIntroducedFacts(
  original: string,
  variation: string,
  sources: string[] = [],
): string[] {
  const allowed = new Set([original, ...sources].flatMap(extractFacts));
  const allowedText = normalise([original, ...sources].join(' '));
  return extractFacts(variation).filter(
    (f) => !allowed.has(f) && !allowedText.includes(f),
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** One stored version of a draft. */
export interface DraftVersion {
  /** "Shorter", "Friendly tone", "For Facebook" — or the generation angle. */
  angle: string;
  body: unknown;
  quality?: unknown;
  /** Absent on versions written at generation (they are originals). */
  kind?: VariationKind | 'original';
  /** Which version it was made from. */
  basedOn?: number;
  createdAt?: string;
  /** For a channel variation: the network it is written for. */
  platform?: SocialPlatformKey;
  tone?: ContentTone;
  /** The facts guard's result. */
  facts?: { introduced: string[]; corrected: boolean };
}

/** Most versions kept per draft; the oldest unused ones go first. */
export const MAX_VERSIONS = 8;

/**
 * Add a version, keeping at most MAX_VERSIONS. The one in use is never
 * dropped; the returned `active` follows it if indexes shift.
 */
export function addVersion(
  versions: DraftVersion[],
  active: number,
  next: DraftVersion,
): { versions: DraftVersion[]; active: number; index: number } {
  const list = [...versions, next];
  let current = active;
  while (list.length > MAX_VERSIONS) {
    const drop = list.findIndex(
      (_, i) => i !== current && i !== list.length - 1,
    );
    list.splice(drop, 1);
    if (drop < current) current -= 1;
  }
  return { versions: list, active: current, index: list.length - 1 };
}

/** Replace exactly one field of a body; everything else is kept as it was. */
export function withField(
  body: unknown,
  field: string,
  value: string,
): Record<string, unknown> {
  const max = FIELD_MAX[field] ?? 300;
  return {
    ...((body ?? {}) as Record<string, unknown>),
    [field]: value.trim().slice(0, max),
  };
}

export const FIELD_LIMIT = (field: string): number => FIELD_MAX[field] ?? 300;
