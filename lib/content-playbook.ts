import type { SocialPlatformKey } from '@/lib/platforms';
import type { ContentTone, ContentTypeKey } from '@/lib/validations/content';
import { FORMAT_SPECS } from '@/lib/content-formats';

/**
 * The content playbook: how copy should be written for where it will run.
 *
 * A LinkedIn post, an Instagram caption and a Facebook post are not the same
 * text at three lengths — each network rewards a different hook, length,
 * hashtag habit and call to action. Until now the generator was keyed only by
 * content TYPE and the platform was chosen after the copy existed, so every
 * network got the same words. This is the single place those conventions
 * live: the generator turns them into instructions, and the quality check
 * (lib/content-quality.ts) holds the result to the same limits.
 *
 * Pure and client-safe.
 */

export interface CopyLimits {
  /** Above this the copy is cut off or rejected by the destination. */
  hardMaxChars: number;
  /** Above this it still posts, but is longer than works well. */
  softMaxChars: number;
  hashtagMin: number;
  hashtagMax: number;
  /** Whether a call to action is expected. */
  ctaExpected: boolean;
}

export interface Playbook {
  /** e.g. "Instagram caption". */
  label: string;
  /** Instructions for the writer, in order. */
  rules: string[];
  limits: CopyLimits;
}

/** How each network's copy is written, regardless of format. */
const PLATFORM_STYLE: Record<
  SocialPlatformKey,
  { name: string; rules: string[] }
> = {
  INSTAGRAM: {
    name: 'Instagram',
    rules: [
      'Instagram: the first line is all most people see before "more" — make it the hook, under 125 characters, no preamble.',
      'Write like a person talking to one follower: short lines, line breaks between thoughts, sensory and specific.',
      'Emoji are welcome where they replace words or add tone — never as decoration on every line.',
      'Hashtags go at the end: 3 to 8, specific to the post and niche, never generic (#love, #instagood).',
    ],
  },
  FACEBOOK: {
    name: 'Facebook',
    rules: [
      'Facebook: conversational and warm, like a post from a local business people know. Shorter performs better — aim for 40–80 words.',
      'Open with something a person would stop for: a moment, a question, a surprising fact from the material.',
      'At most 1–2 hashtags, or none. Emoji sparingly.',
      'End with a natural ask — a question people want to answer, or one clear action.',
    ],
  },
  LINKEDIN: {
    name: 'LinkedIn',
    rules: [
      'LinkedIn: the first two lines decide whether anyone clicks "see more" — a sharp, specific first line, then a reason to keep reading.',
      'Short paragraphs (1–3 sentences) with white space. A point of view and a concrete example beat general advice.',
      'Professional but human: write as an expert talking to a peer, not as a press release.',
      '3 to 5 relevant hashtags at the end. No emoji walls.',
    ],
  },
  X: {
    name: 'X',
    rules: [
      'X: every post is at most 280 characters — count them. Punchy, one idea per post, no filler words.',
      'The first post must stand on its own: a strong claim, number or question from the material.',
      'At most 1–2 hashtags in the whole thread, only if they add reach. No emoji strings.',
    ],
  },
};

/**
 * How each format is built, on top of the network's style — its template in
 * the format registry (lib/content-formats.ts), the one definition of every
 * format.
 */
const FORMAT_RULES: Record<ContentTypeKey, string[]> = Object.fromEntries(
  Object.values(FORMAT_SPECS).map((f) => [f.key, f.template]),
) as Record<ContentTypeKey, string[]>;

/** Limits per format, tightened per network where the network is stricter. */
function limitsFor(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): CopyLimits {
  switch (type) {
    case 'TWEET_THREAD':
      return {
        hardMaxChars: 280 * 12,
        softMaxChars: 280 * 6,
        hashtagMin: 0,
        hashtagMax: 2,
        ctaExpected: false,
      };
    case 'BLOG':
      return {
        hardMaxChars: 40000,
        softMaxChars: 12000,
        hashtagMin: 0,
        hashtagMax: 10,
        ctaExpected: false,
      };
    case 'EMAIL':
      return {
        hardMaxChars: 6000,
        softMaxChars: 2000,
        hashtagMin: 0,
        hashtagMax: 0,
        ctaExpected: true,
      };
    case 'AD':
      return {
        hardMaxChars: 1200,
        softMaxChars: 400,
        hashtagMin: 0,
        hashtagMax: 0,
        ctaExpected: true,
      };
    case 'CAMPAIGN_COPY':
      return {
        hardMaxChars: 2400,
        softMaxChars: 1600,
        hashtagMin: 0,
        hashtagMax: 0,
        ctaExpected: true,
      };
    case 'PROMO':
      return {
        hardMaxChars: 1300,
        softMaxChars: 700,
        hashtagMin: 0,
        hashtagMax: 0,
        ctaExpected: true,
      };
    default:
      break;
  }
  switch (platform) {
    case 'X':
      return {
        hardMaxChars: 280,
        softMaxChars: 240,
        hashtagMin: 0,
        hashtagMax: 2,
        ctaExpected: true,
      };
    case 'INSTAGRAM':
      return {
        hardMaxChars: 2200,
        softMaxChars: 1000,
        hashtagMin: 0,
        hashtagMax: 8,
        ctaExpected: true,
      };
    case 'FACEBOOK':
      return {
        hardMaxChars: 5000,
        softMaxChars: 600,
        hashtagMin: 0,
        hashtagMax: 2,
        ctaExpected: true,
      };
    case 'LINKEDIN':
    default:
      return {
        hardMaxChars: 3000,
        softMaxChars: 1500,
        hashtagMin: 0,
        hashtagMax: 5,
        ctaExpected: true,
      };
  }
}

const FORMAT_LABEL: Record<ContentTypeKey, string> = {
  LINKEDIN_POST: 'post',
  IMAGE_POST: 'image post caption',
  CAROUSEL: 'carousel',
  TWEET_THREAD: 'thread',
  BLOG: 'blog article',
  EMAIL: 'marketing email',
  AD: 'ad',
  CAMPAIGN_COPY: 'campaign copy kit',
  PROMO: 'promotional copy',
};

/**
 * The playbook for a format on a network. Email and blog are not social
 * placements, so the network style applies only to social formats and ads.
 */
export function playbookFor(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): Playbook {
  const social =
    !['EMAIL', 'BLOG', 'CAMPAIGN_COPY', 'PROMO'].includes(type) && platform !== null;
  const style = social ? PLATFORM_STYLE[platform!] : null;
  return {
    label: style ? `${style.name} ${FORMAT_LABEL[type]}` : FORMAT_LABEL[type],
    rules: [...(style ? style.rules : []), ...FORMAT_RULES[type]],
    limits: limitsFor(type, social ? platform : null),
  };
}

// ---------------------------------------------------------------------------
// Writing like a person
// ---------------------------------------------------------------------------

/**
 * Phrases that mark copy as machine-written or as filler. One list, used by
 * the prompt (never write these) and by the quality check (flag if written).
 */
export const ROBOTIC_PHRASES = [
  "in today's fast-paced world",
  'in an era of',
  "it's no secret",
  'it is no secret',
  'we are excited to announce',
  "we're excited to announce",
  'delve into',
  "let's dive in",
  'dive into',
  'unlock the power',
  'unleash',
  'elevate your',
  'game-changer',
  'game changer',
  'revolutionize',
  'cutting-edge',
  'seamless',
  'embark on a journey',
  'look no further',
  'in the realm of',
  'harness the power',
  'navigate the complexities',
  'tapestry',
  'a testament to',
  'ever-evolving',
  'take it to the next level',
  'a must-have',
  'say goodbye to',
  'buckle up',
  'without further ado',
  'in conclusion',
  'when it comes to',
] as const;

/** The rules every piece is written to, whatever the brand. */
export const HUMAN_WRITING_RULES = [
  'Write like a skilled human copywriter who knows this business, not like an AI assistant.',
  'Be specific: real products, real situations, real details from the material provided. Specific beats clever.',
  'Vary sentence length. Use plain words. Contractions are fine where the brand voice allows.',
  'One idea per piece, stated early. Cut anything that does not serve it.',
  'Never claim what the material does not support: no invented numbers, awards, rankings, guarantees, results or customer quotes.',
  'Do not invent specifics about the product, place or process (ingredients, water source, methods, history, tasting notes, staff or customers) beyond what the material says. Describe the experience in general terms instead.',
  'No clichés or filler. Never use: ' +
    ROBOTIC_PHRASES.map((p) => `"${p}"`).join(', ') +
    '.',
  'Do not start several sentences the same way, and do not repeat the same word or idea for effect.',
];

/** Instructions for a requested tone, on top of the brand voice. */
export const TONE_GUIDANCE: Record<ContentTone, string> = {
  professional:
    'Professional: precise, confident, no slang — still human, never stiff.',
  friendly:
    'Friendly: warm and approachable, like talking to a regular customer.',
  playful:
    'Playful: light, witty, a little cheeky — the joke must never undercut the brand or the facts.',
  bold: 'Bold: direct, short sentences, a strong point of view, no hedging.',
  warm: 'Warm: personal and caring, focused on the reader’s moment and feelings.',
  concise:
    'Concise: say it in as few words as possible; every word earns its place.',
};

/** Distinct creative angles, so variations differ in substance, not wording. */
export const VARIATION_ANGLES = [
  'Lead with a specific moment or short story the reader recognises.',
  'Lead with a bold, specific point of view backed by a fact from the material.',
  'Lead with a practical tip, use or idea the reader can act on.',
  // Further angles, for "More recommendations" — the first three are what
  // a new draft's versions take.
  'Lead with the outcome the reader gets, described the way they would say it.',
  'Lead with a question the reader is already asking themselves.',
  'Lead with a behind-the-scenes look at how the business does it.',
  'Lead with a common mistake or misconception, then the better way.',
] as const;
