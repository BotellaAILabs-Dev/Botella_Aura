import type { BriefField } from '@/lib/content-brief';
import type { CopyLimits } from '@/lib/content-playbook';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * CONTENT FORMATS — what Aura can write, and exactly how each is written.
 *
 * One definition per format, read by everything that touches it: the writer's
 * instructions (server/content/generator.ts), the Content Brief's required
 * fields (lib/content-brief.ts), the quality check's CTA rule
 * (lib/content-quality.ts) and the format's rules in the content playbook
 * (lib/content-playbook.ts). For each format:
 *
 *   template        the structure the writer follows, in order
 *   requiredFields  what the brief must carry for this format to be written
 *                   honestly (beyond what every brief needs), and why
 *   channel         where it goes — published to a network by Aura, or
 *                   copied out to another tool — and the constraints there
 *   length          per-part limits (the overall limit comes from the
 *                   playbook, per network)
 *   cta             required / optional / none, where it goes, and how
 *   voice           how the brand voice is applied in this format
 *   output          the JSON shape returned (validated against
 *                   lib/validations/content.ts — the zod schemas)
 *
 * Pure and client-safe. Families map the formats people ask for to the ones
 * Aura has: a social post, a caption, an email, campaign copy, promotional
 * copy, an ad, a carousel, a thread, an article.
 */

export const FORMAT_FAMILIES = {
  social_post: 'Social post',
  caption: 'Caption',
  carousel: 'Carousel',
  thread: 'Thread',
  article: 'Article',
  email: 'Email',
  ad: 'Ad copy',
  campaign_copy: 'Campaign copy',
  promotional_copy: 'Promotional copy',
} as const;
export type FormatFamily = keyof typeof FORMAT_FAMILIES;

export type CtaMode = 'required' | 'optional' | 'none';

export interface FormatSpec {
  key: ContentTypeKey;
  label: string;
  family: FormatFamily;
  /** What it is for, in a line. */
  purpose: string;
  /** The structure the writer follows, in order. */
  template: string[];
  /** Brief fields this format needs, beyond every brief's own required ones. */
  requiredFields: { field: BriefField; why: string }[];
  channel: {
    /** Published to a network by Aura, or copied out to another tool. */
    publishing: 'network' | 'copy_out';
    constraints: string[];
  };
  /** Per-part limits, in words a writer uses. */
  length: string[];
  cta: { mode: CtaMode; placement: string; rule: string };
  /** How the brand voice is applied in this format. */
  voice: string[];
  output: {
    /** The JSON shape, as the writer is told it. */
    schemaText: string;
    /** What each field is. */
    fields: Record<string, string>;
  };
}

const SOCIAL_VOICE = [
  'Write in the brand’s tone and vocabulary from the first line to the last.',
  'Use emoji and hashtags only as the brand does (see its voice); never more.',
];

export const FORMAT_SPECS: Record<ContentTypeKey, FormatSpec> = {
  LINKEDIN_POST: {
    key: 'LINKEDIN_POST',
    label: 'LinkedIn post',
    family: 'social_post',
    purpose:
      'A text-led social post that makes one point and earns a response.',
    template: [
      '`hook`: one line, the scroll-stopper.',
      '`paragraphs`: 3–5 short paragraphs that deliver on the hook.',
      '`cta`: one sentence — the single thing to do next. Not "Thoughts?" on its own.',
    ],
    requiredFields: [],
    channel: {
      publishing: 'network',
      constraints: [
        'Runs on LinkedIn (or Facebook); Aura can publish it where the channel is connected.',
      ],
    },
    length: [
      'Hook: one line, under 300 characters.',
      'Paragraphs: 1–3 sentences each.',
    ],
    cta: {
      mode: 'required',
      placement: 'Its own `cta` field, read after the last paragraph.',
      rule: 'One action. When a link is known, say where it goes; never invent one.',
    },
    voice: SOCIAL_VOICE,
    output: {
      schemaText:
        '{ "hook": string, "paragraphs": string[3..5], "cta": string, "hashtags": string[] (without #) }',
      fields: {
        hook: 'The opening line.',
        paragraphs: 'The body, 3–5 short paragraphs.',
        cta: 'The call to action.',
        hashtags: 'Hashtags without #.',
      },
    },
  },
  IMAGE_POST: {
    key: 'IMAGE_POST',
    label: 'Single image post',
    family: 'caption',
    purpose: 'A caption for one image — it says what the picture cannot.',
    template: [
      '`caption`: the whole post, reading as one piece — it adds what the image cannot say.',
      '`cta`: one short, specific action.',
      '`altText`: one plain sentence describing the image for screen readers.',
    ],
    requiredFields: [],
    channel: {
      publishing: 'network',
      constraints: [
        'Runs on Instagram, Facebook, LinkedIn or X, with one image.',
      ],
    },
    length: [
      'Caption: the first line is the hook (under 125 characters on Instagram).',
      'Alt text: one sentence.',
    ],
    cta: {
      mode: 'required',
      placement: 'Its own `cta` field, after the caption.',
      rule: 'Short and specific ("Save this for your next order"). Instagram links do not click — point to the link in bio instead.',
    },
    voice: SOCIAL_VOICE,
    output: {
      schemaText:
        '{ "caption": string, "cta": string, "hashtags": string[] (without #), "altText": string }',
      fields: {
        caption: 'The caption.',
        cta: 'The call to action.',
        hashtags: 'Hashtags without #.',
        altText: 'Image description.',
      },
    },
  },
  CAROUSEL: {
    key: 'CAROUSEL',
    label: 'Carousel',
    family: 'carousel',
    purpose:
      'A swipeable deck that teaches or shows one thing, a slide at a time.',
    template: [
      'Slide 1 is the cover: a title that promises something specific.',
      'One idea per slide: a short headline and one supporting line.',
      'The last slide pays off the cover. `cta` is the action after the last slide.',
    ],
    requiredFields: [],
    channel: {
      publishing: 'network',
      constraints: ['Runs on LinkedIn, Instagram or Facebook, as 5–8 slides.'],
    },
    length: [
      'Title: under 160 characters.',
      'Each slide: headline under 120, body under 400 characters.',
    ],
    cta: {
      mode: 'required',
      placement: 'Its own `cta` field, after the last slide.',
      rule: 'What to do after swiping — one action.',
    },
    voice: [
      ...SOCIAL_VOICE,
      'Slides are short: keep the voice in word choice, not in length.',
    ],
    output: {
      schemaText:
        '{ "title": string, "slides": [{ "headline": string, "body": string }] (5..8), "cta": string, "hashtags": string[] (without #) }',
      fields: {
        title: 'The cover.',
        slides: '5–8 slides.',
        cta: 'The call to action.',
        hashtags: 'Hashtags without #.',
      },
    },
  },
  TWEET_THREAD: {
    key: 'TWEET_THREAD',
    label: 'X thread',
    family: 'thread',
    purpose: 'A thread on X: a hook, then one idea per post.',
    template: [
      'Tweet 1 is the hook; each following tweet earns its place.',
      'The last tweet closes the loop and carries the call to action.',
      'Do not number the tweets — the order is the number.',
    ],
    requiredFields: [],
    channel: {
      publishing: 'network',
      constraints: ['Runs on X; each post is at most 280 characters.'],
    },
    length: ['2–12 posts, each at most 280 characters.'],
    cta: {
      mode: 'optional',
      placement: 'Inside the last tweet — the thread has no separate field.',
      rule: 'Only if there is a natural next step; never a hard sell.',
    },
    voice: SOCIAL_VOICE,
    output: {
      schemaText:
        '{ "tweets": string[2..12] (each <= 280 chars), "hashtags": string[0..2] (without #) }',
      fields: {
        tweets: 'The posts, in order.',
        hashtags: '0–2 hashtags without #.',
      },
    },
  },
  BLOG: {
    key: 'BLOG',
    label: 'Blog draft',
    family: 'article',
    purpose: 'A structured article for the business’s own site or newsletter.',
    template: [
      'A headline that says what the reader gets, a one-line subtitle, then 2–10 sections with clear headings.',
      'Each section makes one point with a concrete example. No filler introduction, no "In conclusion".',
    ],
    requiredFields: [],
    channel: {
      publishing: 'copy_out',
      constraints: [
        'Published on the business’s own site; Aura does not post it.',
      ],
    },
    length: ['2–10 sections; each section up to about 400 words.'],
    cta: {
      mode: 'optional',
      placement: 'In the last section, as a closing line.',
      rule: 'Only where it follows naturally from the article.',
    },
    voice: [
      'The brand’s voice, at article length: its vocabulary, its sentence rhythm, its point of view.',
    ],
    output: {
      schemaText:
        '{ "headline": string, "subtitle": string, "sections": [{ "heading": string, "body": string }] (2..10), "tags": string[0..10] }',
      fields: {
        headline: 'The title.',
        subtitle: 'One line under it.',
        sections: 'The article.',
        tags: 'Topic tags.',
      },
    },
  },
  EMAIL: {
    key: 'EMAIL',
    label: 'Email',
    family: 'email',
    purpose: 'A marketing email to one reader, with one action.',
    template: [
      '`subjectLine`: under 50 characters, specific, no ALL CAPS or spam words ("FREE!!!", "Act now").',
      '`previewText`: complements the subject — it is the second line in the inbox, not a repeat.',
      '`paragraphs`: 1–4 short paragraphs; one idea; write to one person.',
      '`cta`: the button text — a verb and an outcome ("Book your tasting"), under 5 words.',
      '`signOff`: from a real person or the team, in the brand’s voice.',
    ],
    requiredFields: [
      {
        field: 'cta',
        why: 'An email’s button has to send people somewhere — add your website so it has a destination.',
      },
    ],
    channel: {
      publishing: 'copy_out',
      constraints: [
        'Sent from the business’s own email tool; Aura writes it, does not send it.',
      ],
    },
    length: [
      'Subject: under 50 characters.',
      'Preview: under 160.',
      'Body: 1–4 short paragraphs.',
      'Button: under 5 words.',
    ],
    cta: {
      mode: 'required',
      placement: 'The `cta` field is the button text; the body leads up to it.',
      rule: 'A verb and an outcome. Exactly one action per email.',
    },
    voice: [
      'Write as the brand speaking to one person: the greeting and sign-off carry the voice most.',
      'Keep the subject line plain and specific — voice, not cleverness, at the expense of clarity.',
    ],
    output: {
      schemaText:
        '{ "subjectLine": string, "previewText": string, "greeting": string, "paragraphs": string[1..6], "cta": string, "signOff": string }',
      fields: {
        subjectLine: 'Subject line.',
        previewText: 'Inbox preview line.',
        greeting: 'Opening greeting.',
        paragraphs: 'The body.',
        cta: 'Button text.',
        signOff: 'Sign-off.',
      },
    },
  },
  AD: {
    key: 'AD',
    label: 'Ad copy',
    family: 'ad',
    purpose: 'Paid ad copy for a social placement: one message, one action.',
    template: [
      '`primaryText`: the first 125 characters must make the case on their own (the rest is hidden).',
      '`headline`: under 40 characters, the benefit or offer — not the brand name alone.',
      '`description`: optional supporting line, under 30 characters.',
      '`cta`: a standard ad button label ("Shop now", "Learn more", "Sign up", "Book now", "Get offer").',
      'No hashtags in ads. One message, one action.',
    ],
    requiredFields: [
      {
        field: 'targetAudience',
        why: 'An ad is shown to a chosen audience — say who it is for.',
      },
      {
        field: 'cta',
        why: 'An ad’s button needs a landing page — add your website.',
      },
    ],
    channel: {
      publishing: 'copy_out',
      constraints: [
        'Pasted into the ad platform (Meta, LinkedIn, X); field names match the ad manager’s.',
      ],
    },
    length: [
      'Primary text: first 125 characters carry it.',
      'Headline: under 40.',
      'Description: under 30.',
    ],
    cta: {
      mode: 'required',
      placement: 'The `cta` field is the ad button.',
      rule: 'A standard button label, matching the offer.',
    },
    voice: [
      'Compressed voice: the brand’s words, cut to the fewest. No hashtags or emoji walls.',
    ],
    output: {
      schemaText:
        '{ "headline": string, "primaryText": string, "description": string, "cta": string }',
      fields: {
        headline: 'Ad headline.',
        primaryText: 'Main text.',
        description: 'Supporting line.',
        cta: 'Button label.',
      },
    },
  },
  CAMPAIGN_COPY: {
    key: 'CAMPAIGN_COPY',
    label: 'Campaign copy',
    family: 'campaign_copy',
    purpose:
      'The messaging kit a campaign runs on, to adapt to every channel it uses.',
    template: [
      '`tagline`: the line people remember — at most 8 words.',
      '`keyMessage`: the one sentence the whole campaign stands on.',
      '`shortCopy`: a version that fits a social post, an ad or a banner.',
      '`longCopy`: 2–3 short paragraphs for an email, a landing page or a longer post.',
      '`proofPoints`: up to 4 reasons to believe — only from the evidence or the business’s own material; none if there are none.',
      '`cta`: the action every piece of the campaign drives to.',
    ],
    requiredFields: [
      {
        field: 'marketingGoal',
        why: 'Campaign copy serves a campaign goal — add the goal it is for.',
      },
      {
        field: 'targetAudience',
        why: 'Campaign copy speaks to one audience throughout — say who it is.',
      },
    ],
    channel: {
      publishing: 'copy_out',
      constraints: [
        'Copied into the campaign’s channels; not published as one piece.',
      ],
    },
    length: [
      'Tagline: at most 8 words.',
      'Key message: one sentence.',
      'Short copy: under 280 characters.',
      'Long copy: under 1,200.',
    ],
    cta: {
      mode: 'required',
      placement: 'The `cta` field — the same action across the campaign.',
      rule: 'One action, worded to work in every channel.',
    },
    voice: [
      'The campaign speaks in the brand’s voice, consistently: the short and long versions must sound like the same writer.',
      'The tagline may be the most crafted line, but still in the brand’s words.',
    ],
    output: {
      schemaText:
        '{ "tagline": string, "keyMessage": string, "shortCopy": string, "longCopy": string, "proofPoints": string[0..4], "cta": string }',
      fields: {
        tagline: 'The memorable line.',
        keyMessage: 'What the campaign says.',
        shortCopy: 'Short version.',
        longCopy: 'Long version.',
        proofPoints: 'Reasons to believe.',
        cta: 'The action.',
      },
    },
  },
  PROMO: {
    key: 'PROMO',
    label: 'Promotional copy',
    family: 'promotional_copy',
    purpose:
      'An offer, announced — for a site banner, a newsletter block or a post.',
    template: [
      '`headline`: the benefit or the offer, under 60 characters.',
      '`offer`: what is on offer, exactly as the business states it — never invent a price, discount or product.',
      '`body`: why it is worth it, in 2–4 sentences.',
      '`terms`: conditions only if the business gave them; otherwise empty.',
      '`urgency`: a deadline or limit only if one is real and stated; otherwise empty — no false scarcity.',
      '`cta`: how to claim it.',
    ],
    requiredFields: [
      {
        field: 'cta',
        why: 'An offer needs a place to claim it — add your website.',
      },
    ],
    channel: {
      publishing: 'copy_out',
      constraints: [
        'Copied to the site, a newsletter or a post; Aura does not publish it as one piece.',
      ],
    },
    length: [
      'Headline: under 60 characters.',
      'Offer: one line.',
      'Body: 2–4 sentences, under 800 characters.',
    ],
    cta: {
      mode: 'required',
      placement: 'The `cta` field.',
      rule: 'A verb and the offer ("Claim your first bag").',
    },
    voice: [
      'Enthusiastic within the brand’s voice — never louder than it. No ALL CAPS, no exclamation runs.',
    ],
    output: {
      schemaText:
        '{ "headline": string, "offer": string, "body": string, "terms": string, "urgency": string, "cta": string }',
      fields: {
        headline: 'Headline.',
        offer: 'The offer.',
        body: 'Why it is worth it.',
        terms: 'Stated conditions, or empty.',
        urgency: 'A real deadline, or empty.',
        cta: 'How to claim it.',
      },
    },
  },
};

/** Which content type a family stands for — "a caption" → Single image post. */
export function formatForFamily(family: FormatFamily): ContentTypeKey {
  return (
    Object.values(FORMAT_SPECS).find((f) => f.family === family) ??
    FORMAT_SPECS.LINKEDIN_POST
  ).key;
}

/**
 * Whether the call to action must be there. A format that requires one always
 * does; an optional one does when the brief asks for one.
 */
export function ctaRequired(
  type: ContentTypeKey,
  briefExpectsCta?: boolean | null,
): boolean {
  const mode = FORMAT_SPECS[type].cta.mode;
  return (
    mode === 'required' ||
    (mode === 'optional' && briefExpectsCta === true && type !== 'TWEET_THREAD')
  );
}

/**
 * The format part of the writer's instructions: what it is for, how long,
 * the call to action, how the brand voice applies, and the exact output.
 * (The structure itself — the template — reaches the writer through the
 * content playbook, with the network's rules.)
 */
export function formatInstructions(
  type: ContentTypeKey,
  args: {
    limits: CopyLimits;
    /** Where the call to action sends people, when known. */
    ctaDestination?: string | null;
    /** The brief expects a call to action. */
    ctaExpected?: boolean | null;
  },
): string {
  const f = FORMAT_SPECS[type];
  const required = ctaRequired(type, args.ctaExpected);
  const cta =
    f.cta.mode === 'none'
      ? 'No call to action.'
      : `${required ? 'Required' : 'Optional'}. ${f.cta.placement} ${f.cta.rule}${
          args.ctaDestination
            ? ` It sends people to ${args.ctaDestination}.`
            : ' No link is known — name the next step without a URL.'
        }`;
  return [
    `FORMAT: ${f.label} (${FORMAT_FAMILIES[f.family]}) — ${f.purpose}`,
    `WHERE IT GOES: ${f.channel.constraints.join(' ')}`,
    `LENGTH: ${f.length.join(' ')} Overall: aim for ${args.limits.softMaxChars.toLocaleString('en')} characters, never over ${args.limits.hardMaxChars.toLocaleString('en')}.${
      args.limits.hashtagMax === 0
        ? ' No hashtags.'
        : ` Hashtags: ${args.limits.hashtagMin}–${args.limits.hashtagMax}.`
    }`,
    `CALL TO ACTION: ${cta}`,
    `BRAND VOICE IN THIS FORMAT: ${f.voice.join(' ')}`,
  ].join('\n');
}
