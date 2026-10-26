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
// Topic
// ---------------------------------------------------------------------------

/**
 * Words too common to say anything about what a piece is ABOUT. Marketing
 * filler is in here as well as grammar: "solution", "business" and "team"
 * appear in every post a brand writes, so counting them as shared subject
 * matter would make two unrelated posts look like the same topic.
 */
const TOPIC_STOP = new Set([
  'about', 'above', 'after', 'again', 'against', 'already', 'also', 'always',
  'another', 'anyone', 'anything', 'around', 'because', 'been', 'before',
  'being', 'below', 'better', 'between', 'both', 'bring', 'brings', 'came',
  'come', 'comes', 'could', 'does', 'doing', 'done', 'down', 'during', 'each',
  'early', 'else', 'enough', 'even', 'ever', 'every', 'first', 'from', 'getting',
  'give', 'gives', 'going', 'good', 'great', 'half', 'have', 'having', 'help',
  'helps', 'here', 'high', 'into', 'just', 'keep', 'know', 'last', 'later',
  'least', 'less', 'like', 'little', 'long', 'look', 'looking', 'made', 'make',
  'makes', 'making', 'many', 'might', 'more', 'most', 'much', 'must', 'need',
  'needs', 'never', 'next', 'nothing', 'often', 'once', 'only', 'other',
  'others', 'over', 'own', 'part', 'people', 'place', 'really', 'right', 'same',
  'says', 'see', 'seen', 'should', 'since', 'some', 'something', 'start',
  'started', 'still', 'such', 'sure', 'take', 'takes', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'think', 'this',
  'those', 'through', 'time', 'today', 'together', 'took', 'under', 'until',
  'used', 'using', 'very', 'want', 'wants', 'well', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'within', 'without', 'work',
  'working', 'would', 'year', 'years', 'your',
  // Marketing filler — present in everything, so evidence of nothing.
  'business', 'brand', 'customer', 'customers', 'client', 'clients', 'team',
  'teams', 'company', 'companies', 'product', 'products', 'service',
  'services', 'solution', 'solutions', 'market', 'marketing', 'growth',
  'result', 'results', 'best', 'new', 'more',
]);

/** The words that carry a piece's subject: content words, 4+ characters. */
export function topicTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9'-]+/)) {
    const w = raw.replace(/^[''-]+|[''-]+$/g, '');
    if (w.length < 4 || TOPIC_STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/**
 * Enough singularisation that "distilleries", "distillery" and "distillers"
 * count as the same subject. Deliberately crude — this feeds a ratio, so a
 * word stemmed oddly costs a little accuracy in one term, and a real stemmer
 * is a dependency for no gain here.
 */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches')))
    return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us'))
    return w.slice(0, -1);
  return w;
}

/**
 * How much subject matter the original and the variation share, 0–1.
 *
 * The naive version of this — the share of the ORIGINAL's subject words the
 * variation still uses — is wrong, and wrong in the direction that hurts:
 * "make it 40% shorter" is a legitimate variation whose whole job is to drop
 * material. A shortened post scores about 0.24 that way and would be blocked
 * as off-topic, which is a false accusation about the user's own request.
 *
 * So this takes the better of the two directions:
 *   - how much of the original the variation kept (catches a version that
 *     abandoned the subject), and
 *   - how much of the variation is drawn from the original (catches a version
 *     that is mostly new subject matter).
 * A shorter version scores high on the second, a reworded one on the first,
 * and a post about something else scores low on both — which is the only case
 * worth blocking.
 */
export function topicOverlap(original: string, variation: string): number {
  const a = topicTerms(original);
  const b = topicTerms(variation);
  // Nothing distinctive to compare: on topic by default. Never a false block
  // on a post whose subject words the stop list happens to cover.
  if (a.size === 0 || b.size === 0) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return Math.max(shared / a.size, shared / b.size);
}

/**
 * Below this share of the original's subject words, a variation has drifted
 * off topic.
 *
 * Set from the floor rather than the ideal: a legitimate "different hook, same
 * subject" rewrite keeps well over half of the original's subject words, and a
 * genuinely rewritten short post about the same thing still lands around 0.4.
 * The cases this catches are the ones that kept the brand and the format and
 * changed what the piece is about.
 */
export const TOPIC_DRIFT_FLOOR = 0.3;

/** Subject words from the original that the variation dropped entirely. */
export function droppedTopicTerms(
  original: string,
  variation: string,
  limit = 6,
): string[] {
  const b = topicTerms(variation);
  return [...topicTerms(original)].filter((w) => !b.has(w)).slice(0, limit);
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
  /**
   * This version's own earlier texts (newest first), kept when it is edited
   * or rewritten on its own, so it can be reverted without touching the
   * other versions.
   */
  previous?: { body: unknown; at: string; note: string }[];
}

/** Earlier texts kept per version. */
export const VERSION_HISTORY_LIMIT = 5;

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
