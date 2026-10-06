import type { SocialPlatformKey } from '@/lib/platforms';
import type { ContentTone, ContentTypeKey } from '@/lib/validations/content';

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

/** How each format is built, on top of the network's style. */
const FORMAT_RULES: Record<ContentTypeKey, string[]> = {
  LINKEDIN_POST: [
    '`hook`: one line, the scroll-stopper.',
    '`paragraphs`: 3–5 short paragraphs that deliver on the hook.',
    '`cta`: one sentence — the single thing to do next. Not "Thoughts?" on its own.',
  ],
  IMAGE_POST: [
    '`caption`: the whole post, reading as one piece — it adds what the image cannot say.',
    '`cta`: one short, specific action.',
    '`altText`: one plain sentence describing the image for screen readers.',
  ],
  CAROUSEL: [
    'Slide 1 is the cover: a title that promises something specific.',
    'One idea per slide: a short headline and one supporting line.',
    'The last slide pays off the cover. `cta` is the action after the last slide.',
  ],
  TWEET_THREAD: [
    'Tweet 1 is the hook; each following tweet earns its place.',
    'The last tweet closes the loop and carries the call to action.',
    'Do not number the tweets — the order is the number.',
  ],
  BLOG: [
    'A headline that says what the reader gets, a one-line subtitle, then 2–10 sections with clear headings.',
    'Each section makes one point with a concrete example. No filler introduction, no "In conclusion".',
  ],
  EMAIL: [
    '`subjectLine`: under 50 characters, specific, no ALL CAPS or spam words ("FREE!!!", "Act now").',
    '`previewText`: complements the subject — it is the second line in the inbox, not a repeat.',
    '`paragraphs`: 1–4 short paragraphs; one idea; write to one person.',
    '`cta`: the button text — a verb and an outcome ("Book your tasting"), under 5 words.',
    '`signOff`: from a real person or the team, in the brand’s voice.',
  ],
  AD: [
    '`primaryText`: the first 125 characters must make the case on their own (the rest is hidden).',
    '`headline`: under 40 characters, the benefit or offer — not the brand name alone.',
    '`description`: optional supporting line, under 30 characters.',
    '`cta`: a standard ad button label ("Shop now", "Learn more", "Sign up", "Book now", "Get offer").',
    'No hashtags in ads. One message, one action.',
  ],
};

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
};

/**
 * The playbook for a format on a network. Email and blog are not social
 * placements, so the network style applies only to social formats and ads.
 */
export function playbookFor(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): Playbook {
  const social = type !== 'EMAIL' && type !== 'BLOG' && platform !== null;
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
] as const;
