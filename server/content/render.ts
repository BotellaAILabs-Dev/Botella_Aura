import type { ContentDraft } from '@prisma/client';
import {
  bodySchemaFor,
  type ContentTypeKey,
  type LinkedInPostBody,
  type CarouselBody,
  type ThreadBody,
  type BlogBody,
} from '@/lib/validations/content';

/**
 * Render a draft's structured body into plain text suitable for copy-paste into
 * LinkedIn / X — the "copy for manual posting" fallback for content types the
 * official API can't publish natively (carousels, threads, blogs). This never
 * fabricates a "published" state; it just formats what the user posts by hand.
 */
export function renderForManual(draft: ContentDraft): string {
  const type = draft.type as ContentTypeKey;
  const parsed = bodySchemaFor(type).safeParse(draft.body);
  if (!parsed.success) return '';

  switch (type) {
    case 'LINKEDIN_POST': {
      const b = parsed.data as LinkedInPostBody;
      const hashtags = b.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ');
      return [b.hook, '', b.paragraphs.join('\n\n'), '', hashtags]
        .filter((s) => s !== undefined)
        .join('\n')
        .trim();
    }
    case 'CAROUSEL': {
      const b = parsed.data as CarouselBody;
      const slides = b.slides
        .map((s, i) => `Slide ${i + 1}: ${s.headline}\n${s.body}`.trim())
        .join('\n\n');
      const hashtags = b.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ');
      return [b.title, '', slides, '', hashtags].join('\n').trim();
    }
    case 'TWEET_THREAD': {
      const b = parsed.data as ThreadBody;
      return b.tweets.map((t, i) => `${i + 1}/ ${t}`).join('\n\n');
    }
    case 'BLOG': {
      const b = parsed.data as BlogBody;
      const sections = b.sections
        .map((s) => `## ${s.heading}\n\n${s.body}`)
        .join('\n\n');
      return [`# ${b.headline}`, b.subtitle, '', sections].filter(Boolean).join('\n\n').trim();
    }
  }
}

/** LinkedIn post → the commentary string the official /rest/posts API expects. */
export function renderLinkedInCommentary(draft: ContentDraft): string | null {
  const parsed = bodySchemaFor('LINKEDIN_POST').safeParse(draft.body);
  if (!parsed.success) return null;
  const b = parsed.data as LinkedInPostBody;
  const hashtags = b.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ');
  return [b.hook, '', b.paragraphs.join('\n\n'), hashtags && `\n${hashtags}`]
    .filter(Boolean)
    .join('\n')
    .trim();
}
