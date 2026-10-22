import { detailsOf, renderDetails } from '@/lib/post-details';
import {
  Image as ImageIcon,
  Linkedin,
  Mail,
  Megaphone,
  Tag,
  Target,
  Twitter,
} from 'lucide-react';
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

  const lines = renderDetails(detailsOf(parsed.data));
  const preview = previewFor(type, parsed.data);
  if (!lines.length) return preview;
  // The post's details (website, address, phone, email) are posted after
  // the copy — shown here exactly as they will read.
  return (
    <div className="space-y-2">
      {preview}
      <div className="rounded-md border border-dashed border-border px-4 py-3 text-sm" aria-label="Post details">
        {lines.map((l) => (
          <p key={l} className="break-words [overflow-wrap:anywhere]">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function previewFor(type: ContentTypeKey, data: unknown) {
  const parsed = { data };
  switch (type) {
    case 'LINKEDIN_POST':
      return <PostPreview b={parsed.data as LinkedInPostBody} />;
    case 'IMAGE_POST':
      return <ImagePostPreview b={parsed.data as ImagePostBody} />;
    case 'CAROUSEL':
      return <CarouselPreview b={parsed.data as CarouselBody} />;
    case 'TWEET_THREAD':
      return <ThreadPreview b={parsed.data as ThreadBody} />;
    case 'BLOG':
      return <BlogPreview b={parsed.data as BlogBody} />;
    case 'EMAIL':
      return <EmailPreview b={parsed.data as EmailBody} />;
    case 'AD':
      return <AdPreview b={parsed.data as AdBody} />;
    case 'CAMPAIGN_COPY':
      return <CampaignCopyPreview b={parsed.data as CampaignCopyBody} />;
    case 'PROMO':
      return <PromoPreview b={parsed.data as PromoBody} />;
  }
}

/** Campaign copy: the kit, part by part, as it will be used. */
function CampaignCopyPreview({ b }: { b: CampaignCopyBody }) {
  const Part = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="whitespace-pre-wrap text-sm text-foreground">{children}</div>
    </div>
  );
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Target className="h-4 w-4 text-primary" /> Campaign copy
      </div>
      <p className="text-xl font-semibold text-foreground">{b.tagline}</p>
      <Part label="Key message">{b.keyMessage}</Part>
      <Part label="Short copy">{b.shortCopy}</Part>
      <Part label="Long copy">{b.longCopy}</Part>
      {b.proofPoints.length > 0 && (
        <Part label="Proof points">
          <ul className="list-disc space-y-0.5 pl-5">
            {b.proofPoints.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Part>
      )}
      <Cta text={b.cta} />
    </div>
  );
}

/** Promotional copy: as a banner block would show it. */
function PromoPreview({ b }: { b: PromoBody }) {
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Tag className="h-4 w-4 text-primary" /> Promotion
      </div>
      <p className="text-lg font-semibold text-foreground">{b.headline}</p>
      <p className="text-sm font-medium text-primary">{b.offer}</p>
      <p className="whitespace-pre-wrap text-sm text-foreground">{b.body}</p>
      {b.urgency && <p className="text-xs font-medium text-foreground">{b.urgency}</p>}
      {b.terms && <p className="text-xs text-muted-foreground">Terms: {b.terms}</p>}
      {b.cta && (
        <span className="inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
          {b.cta}
        </span>
      )}
    </div>
  );
}

/** The call to action, shown as its own line so it is obvious there is one. */
function Cta({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <p className="mt-3 text-sm font-medium text-primary">
      <span className="mr-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
        CTA
      </span>
      {text}
    </p>
  );
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
      <Cta text={b.cta} />
      <Hashtags tags={b.hashtags} />
    </div>
  );
}

/**
 * Caption and the space the graphic will occupy.
 *
 * The empty frame is deliberate. This format is not finished without an image,
 * and a preview that showed only the caption would look complete while being
 * half a post — so the gap is drawn rather than left to be inferred.
 */
function ImagePostPreview({ b }: { b: ImagePostBody }) {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <ImageIcon className="h-4 w-4 text-primary" /> Single image post preview
      </div>
      <div className="mb-4 flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/40">
        <p className="px-6 text-center text-xs text-muted-foreground">
          {b.altText
            ? b.altText
            : 'Your graphic goes here — generate or upload one below.'}
        </p>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{b.caption}</p>
      <Cta text={b.cta} />
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
      <Cta text={b.cta} />
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
      <Hashtags tags={b.hashtags} />
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

function EmailPreview({ b }: { b: EmailBody }) {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-card shadow-sm">
      <div className="space-y-1 border-b border-border p-4 text-sm">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          <Mail className="h-4 w-4 text-primary" /> Email preview
        </div>
        <p>
          <span className="text-muted-foreground">Subject: </span>
          <span className="font-semibold text-foreground">{b.subjectLine}</span>
        </p>
        {b.previewText && (
          <p className="text-muted-foreground">{b.previewText}</p>
        )}
      </div>
      <div className="space-y-3 p-5 text-sm text-foreground">
        {b.greeting && <p>{b.greeting}</p>}
        {b.paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap">
            {p}
          </p>
        ))}
        {b.cta && (
          <div className="pt-1">
            <span className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              {b.cta}
            </span>
          </div>
        )}
        {b.signOff && (
          <p className="whitespace-pre-wrap text-muted-foreground">{b.signOff}</p>
        )}
      </div>
    </div>
  );
}

/** Laid out like a feed ad: primary text, then the headline row with its button. */
function AdPreview({ b }: { b: AdBody }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 p-4 pb-2 text-sm text-muted-foreground">
        <Megaphone className="h-4 w-4 text-primary" /> Ad preview · Sponsored
      </div>
      <p className="whitespace-pre-wrap px-4 pb-3 text-sm text-foreground">
        {b.primaryText}
      </p>
      <div className="flex aspect-[1.91/1] items-center justify-center border-y border-dashed border-border bg-muted/40 text-xs text-muted-foreground">
        Ad image or video
      </div>
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{b.headline}</p>
          {b.description && (
            <p className="truncate text-xs text-muted-foreground">{b.description}</p>
          )}
        </div>
        <span className="shrink-0 rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground">
          {b.cta}
        </span>
      </div>
    </div>
  );
}
