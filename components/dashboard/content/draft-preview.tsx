import { Linkedin, Twitter } from 'lucide-react';
import {
  bodySchemaFor,
  type ContentTypeKey,
  type LinkedInPostBody,
  type CarouselBody,
  type ThreadBody,
  type BlogBody,
} from '@/lib/validations/content';

/**
 * Renders a draft's structured body appropriately per type — a LinkedIn-style
 * post card, a swipeable carousel, a numbered tweet stack, or a blog layout.
 * Pure/server-safe. Invalid bodies fail closed to a small notice (never crash).
 */
export function DraftPreview({
  type,
  body,
}: {
  type: ContentTypeKey;
  body: unknown;
}) {
  const parsed = bodySchemaFor(type).safeParse(body);
  if (!parsed.success) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        This draft&apos;s content couldn&apos;t be rendered. Try Regenerate.
      </div>
    );
  }

  switch (type) {
    case 'LINKEDIN_POST':
      return <PostPreview b={parsed.data as LinkedInPostBody} />;
    case 'CAROUSEL':
      return <CarouselPreview b={parsed.data as CarouselBody} />;
    case 'TWEET_THREAD':
      return <ThreadPreview b={parsed.data as ThreadBody} />;
    case 'BLOG':
      return <BlogPreview b={parsed.data as BlogBody} />;
  }
}

/**
 * Hashtags shown as their own labelled block, separate from the post copy — so
 * it's obvious what's the message vs. the tags, and either can be copied on its
 * own. (Hashtags are appended to the copy in "Copy for manual posting".)
 */
function Hashtags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Hashtags
      </p>
      <p className="text-sm text-primary">
        {tags.map((t) => `#${t.replace(/^#/, '')}`).join(' ')}
      </p>
    </div>
  );
}

function PostPreview({ b }: { b: LinkedInPostBody }) {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Linkedin className="h-4 w-4 text-[#0A66C2]" /> LinkedIn post preview
      </div>
      <p className="whitespace-pre-wrap font-medium text-foreground">{b.hook}</p>
      <div className="mt-3 space-y-3 text-sm text-foreground">
        {b.paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap">
            {p}
          </p>
        ))}
      </div>
      <Hashtags tags={b.hashtags} />
    </div>
  );
}

function CarouselPreview({ b }: { b: CarouselBody }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">{b.title}</p>
      <div className="flex gap-3 overflow-x-auto pb-3">
        {b.slides.map((s, i) => (
          <div
            key={i}
            className="flex aspect-square w-56 shrink-0 flex-col justify-between rounded-lg border border-border bg-gradient-to-br from-primary/5 to-card p-4 shadow-sm"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {i + 1}/{b.slides.length}
            </span>
            <div>
              <p className="text-base font-semibold text-foreground">
                {s.headline}
              </p>
              {s.body && (
                <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <Hashtags tags={b.hashtags} />
    </div>
  );
}

function ThreadPreview({ b }: { b: ThreadBody }) {
  return (
    <div className="mx-auto max-w-xl space-y-2">
      <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
        <Twitter className="h-4 w-4" /> Thread preview
      </div>
      {b.tweets.map((t, i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-card p-3 text-sm shadow-xs"
        >
          <span className="mr-1 font-medium text-muted-foreground">{i + 1}/</span>
          <span className="whitespace-pre-wrap text-foreground">{t}</span>
        </div>
      ))}
    </div>
  );
}

function BlogPreview({ b }: { b: BlogBody }) {
  return (
    <article className="prose-sm mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {b.headline}
      </h1>
      {b.subtitle && (
        <p className="mt-1 text-base text-muted-foreground">{b.subtitle}</p>
      )}
      <div className="mt-4 space-y-5">
        {b.sections.map((s, i) => (
          <section key={i}>
            <h2 className="text-lg font-semibold text-foreground">{s.heading}</h2>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">
              {s.body}
            </p>
          </section>
        ))}
      </div>
      {b.tags.length > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          {b.tags.map((t) => `#${t}`).join(' ')}
        </p>
      )}
    </article>
  );
}
