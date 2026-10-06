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
} from '@/lib/validations/content';

/** Shared, client-safe content-type presentation helpers (no React). */

export const CONTENT_TYPE_LABELS: Record<ContentTypeKey, string> = {
  LINKEDIN_POST: 'LinkedIn post',
  IMAGE_POST: 'Single image post',
  CAROUSEL: 'Carousel',
  TWEET_THREAD: 'X thread',
  BLOG: 'Blog draft',
  EMAIL: 'Email',
  AD: 'Ad copy',
};

export type ContentStatusKey =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED';

export const CONTENT_STATUS_LABELS: Record<ContentStatusKey, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PUBLISHED: 'Published',
};

/** A short preview snippet derived from a draft's structured body. */
export function draftSnippet(type: ContentTypeKey, body: unknown): string {
  const parsed = bodySchemaFor(type).safeParse(body);
  if (!parsed.success) return '(unrenderable draft)';
  switch (type) {
    case 'LINKEDIN_POST':
      return (parsed.data as LinkedInPostBody).hook;
    case 'IMAGE_POST':
      return (parsed.data as ImagePostBody).caption;
    case 'CAROUSEL':
      return (parsed.data as CarouselBody).title;
    case 'TWEET_THREAD':
      return (parsed.data as ThreadBody).tweets[0] ?? '';
    case 'BLOG':
      return (parsed.data as BlogBody).headline;
    case 'EMAIL':
      return (parsed.data as EmailBody).subjectLine;
    case 'AD':
      return (parsed.data as AdBody).headline;
  }
}
