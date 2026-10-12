import type { ContentDraft } from '@prisma/client';
import {
  bodySchemaFor,
  type ContentTypeKey,
  type LinkedInPostBody,
  type ImagePostBody,
  type CarouselBody,
  type ThreadBody,
  type BlogBody,
  type EmailBody,
  type AdBody,
  type CampaignCopyBody,
  type PromoBody,
} from '@/lib/validations/content';

const tags = (list: string[]) =>
  list.map((h) => `#${h.replace(/^#/, '')}`).join(' ');

/** Join lines, dropping empty ones and collapsing runs of blank lines. */
const lines = (parts: (string | false | null | undefined)[]) =>
  parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Render a draft's structured body into plain text suitable for copy-paste into
 * LinkedIn / X — the "copy for manual posting" fallback for content types the
 * official API can't publish natively (carousels, threads, blogs), and the
 * copy-out for email and ad copy. This never fabricates a "published" state;
 * it just formats what the user posts by hand.
 */
export function renderForManual(draft: ContentDraft): string {
  const type = draft.type as ContentTypeKey;
  const parsed = bodySchemaFor(type).safeParse(draft.body);
  if (!parsed.success) return '';

  switch (type) {
    case 'LINKEDIN_POST': {
      const b = parsed.data as LinkedInPostBody;
      return lines([
        b.hook,
        '',
        b.paragraphs.join('\n\n'),
        b.cta && `\n${b.cta}`,
        '',
        tags(b.hashtags),
      ]);
    }
    case 'IMAGE_POST': {
      const b = parsed.data as ImagePostBody;
      return lines([b.caption, b.cta && `\n${b.cta}`, '', tags(b.hashtags)]);
    }
    case 'CAROUSEL': {
      const b = parsed.data as CarouselBody;
      const slides = b.slides
        .map((s, i) => `Slide ${i + 1}: ${s.headline}\n${s.body}`.trim())
        .join('\n\n');
      return lines([
        b.title,
        '',
        slides,
        b.cta && `\n${b.cta}`,
        '',
        tags(b.hashtags),
      ]);
    }
    case 'TWEET_THREAD': {
      const b = parsed.data as ThreadBody;
      const thread = b.tweets.map((t, i) => `${i + 1}/ ${t}`).join('\n\n');
      return b.hashtags.length ? `${thread} ${tags(b.hashtags)}` : thread;
    }
    case 'BLOG': {
      const b = parsed.data as BlogBody;
      const sections = b.sections
        .map((s) => `## ${s.heading}\n\n${s.body}`)
        .join('\n\n');
      return [`# ${b.headline}`, b.subtitle, '', sections]
        .filter(Boolean)
        .join('\n\n')
        .trim();
    }
    case 'EMAIL': {
      const b = parsed.data as EmailBody;
      return lines([
        `Subject: ${b.subjectLine}`,
        b.previewText && `Preview: ${b.previewText}`,
        '',
        b.greeting && `${b.greeting}\n`,
        b.paragraphs.join('\n\n'),
        b.cta && `\n[ ${b.cta} ]`,
        b.signOff && `\n${b.signOff}`,
      ]);
    }
    case 'AD': {
      const b = parsed.data as AdBody;
      return [
        `Primary text: ${b.primaryText}`,
        `Headline: ${b.headline}`,
        b.description && `Description: ${b.description}`,
        `Button: ${b.cta}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'CAMPAIGN_COPY': {
      const b = parsed.data as CampaignCopyBody;
      return [
        `Tagline: ${b.tagline}`,
        `Key message: ${b.keyMessage}`,
        `Short copy:\n${b.shortCopy}`,
        `Long copy:\n${b.longCopy}`,
        b.proofPoints.length && `Proof points:\n${b.proofPoints.map((p) => `- ${p}`).join('\n')}`,
        b.cta && `Call to action: ${b.cta}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'PROMO': {
      const b = parsed.data as PromoBody;
      return [
        b.headline,
        b.offer,
        b.body,
        b.urgency,
        b.terms && `Terms: ${b.terms}`,
        b.cta && `[ ${b.cta} ]`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
  }
}

/** LinkedIn post → the commentary string the official /rest/posts API expects. */
export function renderLinkedInCommentary(draft: ContentDraft): string | null {
  const parsed = bodySchemaFor('LINKEDIN_POST').safeParse(draft.body);
  if (!parsed.success) return null;
  const b = parsed.data as LinkedInPostBody;
  const hashtags = tags(b.hashtags);
  return [
    b.hook,
    '',
    b.paragraphs.join('\n\n'),
    b.cta && `\n${b.cta}`,
    hashtags && `\n${hashtags}`,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}
