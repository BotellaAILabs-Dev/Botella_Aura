import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * How each content type's body is edited as a form.
 *
 * The edit box used to be the draft's raw JSON: fine for a developer, useless
 * for a business owner fixing a typo in a hook. Each field here matches a key
 * of the type's schema (lib/validations/content.ts) with its limits, so the
 * form can say "Hook — 212/300" and the schema still has the last word on
 * save. Keys the form does not list (post details) are carried through
 * untouched.
 *
 * Client-safe and pure; the editor is components/dashboard/content/draft-fields-editor.tsx.
 */

export type DraftField =
  | { kind: 'text' | 'textarea'; key: string; label: string; max: number; required?: boolean; hint?: string }
  /** A list of short texts, one per row (paragraphs, tweets, proof points). */
  | { kind: 'list'; key: string; label: string; itemLabel: string; max: number; min: number; maxItems: number; long?: boolean }
  /** Hashtags or tags, edited as one comma-separated line. */
  | { kind: 'tags'; key: string; label: string; maxItems: number; hint?: string }
  /** A list of small objects (carousel slides, blog sections). */
  | {
      kind: 'group';
      key: string;
      label: string;
      itemLabel: string;
      min: number;
      maxItems: number;
      fields: { key: string; label: string; max: number; long?: boolean; required?: boolean }[];
    };

const cta = { kind: 'text', key: 'cta', label: 'Call to action', max: 300 } as const;

export const DRAFT_FIELDS: Record<ContentTypeKey, DraftField[]> = {
  LINKEDIN_POST: [
    { kind: 'textarea', key: 'hook', label: 'Hook', max: 300, required: true, hint: 'The first line people see before “…see more”.' },
    { kind: 'list', key: 'paragraphs', label: 'Paragraphs', itemLabel: 'Paragraph', max: 1200, min: 3, maxItems: 5, long: true },
    cta,
    { kind: 'tags', key: 'hashtags', label: 'Hashtags', maxItems: 8 },
  ],
  IMAGE_POST: [
    { kind: 'textarea', key: 'caption', label: 'Caption', max: 2200, required: true },
    cta,
    { kind: 'tags', key: 'hashtags', label: 'Hashtags', maxItems: 12 },
    { kind: 'text', key: 'altText', label: 'Image description (alt text)', max: 420, hint: 'Read aloud by screen readers.' },
  ],
  CAROUSEL: [
    { kind: 'text', key: 'title', label: 'Title', max: 160, required: true },
    {
      kind: 'group',
      key: 'slides',
      label: 'Slides',
      itemLabel: 'Slide',
      min: 5,
      maxItems: 8,
      fields: [
        { key: 'headline', label: 'Headline', max: 120, required: true },
        { key: 'body', label: 'Text', max: 400, long: true },
      ],
    },
    cta,
    { kind: 'tags', key: 'hashtags', label: 'Hashtags', maxItems: 8 },
  ],
  TWEET_THREAD: [
    { kind: 'list', key: 'tweets', label: 'Posts in the thread', itemLabel: 'Post', max: 280, min: 2, maxItems: 12, long: true },
    { kind: 'tags', key: 'hashtags', label: 'Hashtags', maxItems: 3, hint: 'One or two, added to the last post.' },
  ],
  BLOG: [
    { kind: 'text', key: 'headline', label: 'Headline', max: 200, required: true },
    { kind: 'textarea', key: 'subtitle', label: 'Subtitle', max: 300 },
    {
      kind: 'group',
      key: 'sections',
      label: 'Sections',
      itemLabel: 'Section',
      min: 2,
      maxItems: 10,
      fields: [
        { key: 'heading', label: 'Heading', max: 160, required: true },
        { key: 'body', label: 'Text', max: 4000, long: true, required: true },
      ],
    },
    { kind: 'tags', key: 'tags', label: 'Tags', maxItems: 10 },
  ],
  EMAIL: [
    { kind: 'text', key: 'subjectLine', label: 'Subject line', max: 120, required: true },
    { kind: 'text', key: 'previewText', label: 'Preview text', max: 160, hint: 'Shown after the subject in the inbox.' },
    { kind: 'text', key: 'greeting', label: 'Greeting', max: 80 },
    { kind: 'list', key: 'paragraphs', label: 'Paragraphs', itemLabel: 'Paragraph', max: 1500, min: 1, maxItems: 6, long: true },
    { ...cta, label: 'Button text' },
    { kind: 'text', key: 'signOff', label: 'Sign-off', max: 160 },
  ],
  AD: [
    { kind: 'text', key: 'headline', label: 'Headline', max: 80, required: true },
    { kind: 'textarea', key: 'primaryText', label: 'Primary text', max: 1000, required: true },
    { kind: 'text', key: 'description', label: 'Description', max: 120 },
    { kind: 'text', key: 'cta', label: 'Button label', max: 40 },
  ],
  CAMPAIGN_COPY: [
    { kind: 'text', key: 'tagline', label: 'Tagline', max: 80, required: true },
    { kind: 'textarea', key: 'keyMessage', label: 'Key message', max: 300, required: true },
    { kind: 'textarea', key: 'shortCopy', label: 'Short copy', max: 280, required: true },
    { kind: 'textarea', key: 'longCopy', label: 'Long copy', max: 1200, required: true },
    { kind: 'list', key: 'proofPoints', label: 'Proof points', itemLabel: 'Proof point', max: 200, min: 0, maxItems: 4 },
    cta,
  ],
  PROMO: [
    { kind: 'text', key: 'headline', label: 'Headline', max: 80, required: true },
    { kind: 'text', key: 'offer', label: 'Offer', max: 200, required: true },
    { kind: 'textarea', key: 'body', label: 'Text', max: 800, required: true },
    { kind: 'text', key: 'terms', label: 'Terms', max: 300 },
    { kind: 'text', key: 'urgency', label: 'Deadline or limit', max: 120 },
    cta,
  ],
};

/** "#coffee, #morning ritual" → ['#coffee', '#morning ritual'], de-duplicated. */
export function parseTags(line: string): string[] {
  const out: string[] = [];
  for (const raw of line.split(',')) {
    const t = raw.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/**
 * Turns a schema error path into the field it belongs to, so the message
 * shows under that field: ['slides', 2, 'headline'] → 'slides.2.headline'.
 */
export function issueKey(path: readonly (string | number)[]): string {
  return path.join('.');
}
