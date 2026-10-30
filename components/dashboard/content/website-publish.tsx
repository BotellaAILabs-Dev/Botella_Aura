'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, ExternalLink, Eye, FileText, Globe, RotateCw, Send, TriangleAlert, X } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TagInput } from '@/components/ui/tag-input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { PublishStateBadge } from '@/components/dashboard/websites/status-badges';
import { actOnPublication, type PublicationRow } from '@/components/dashboard/websites/publishing-history';
import { escapeHtml, META_DESCRIPTION_MAX, SEO_TITLE_MAX, slugify, type PublishOptions } from '@/lib/blog-html';
import { SEO_FIELD_LABELS, websitePlatform, type BlogPublishState, type SeoField } from '@/lib/website-platforms';
import { safeExternalUrl } from '@/lib/safe-url';
import { toLocalInput } from '@/lib/timezone';

interface SiteState {
  website: { id: string; name: string; platform: string; platformName: string; siteUrl: string; state: string };
  state: BlogPublishState;
  stateLabel: string;
  publication: (PublicationRow & { seoReport: Record<string, { outcome: string; note?: string }> }) | null;
  blockers: string[];
  options: PublishOptions;
}

interface State {
  approved: boolean;
  blockers: string[];
  websites: SiteState[];
  featuredImage: { url: string; alt: string } | null;
  inlineImages: number;
  timeZone: string;
  canPublish: boolean;
}

interface SiteOptions {
  categories?: { id: string; name: string }[];
  authors?: { id: string; name: string }[];
  blogs?: { id: string; name: string }[];
  recentPosts?: { title: string; url: string }[];
}

type Action = 'publish' | 'draft' | 'schedule';

const OUTCOME_LABEL: Record<string, string> = { applied: 'sent', fallback: 'closest option', unsupported: 'not supported', empty: 'empty' };

/**
 * "Publish to your website" on a blog: choose the site, check the SEO fields,
 * preview exactly what the site receives, then publish, save as a draft, or
 * schedule. Every site's state is shown, with Retry for a failure.
 */
export function WebsitePublish({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [opts, setOpts] = useState<PublishOptions | null>(null);
  const [siteOptions, setSiteOptions] = useState<SiteOptions | null>(null);
  const [action, setAction] = useState<Action>('publish');
  const [scheduleMode, setScheduleMode] = useState<'publish' | 'draft'>('publish');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/content/drafts/${draftId}/website-publish`);
    if (!r.ok) return;
    const s = (await r.json()) as State;
    setState(s);
    setSiteId((cur) => cur ?? s.websites.find((w) => w.state === 'ready')?.website.id ?? s.websites[0]?.website.id ?? null);
  }, [draftId]);
  useEffect(() => {
    void load();
  }, [load]);

  const site = useMemo(() => state?.websites.find((w) => w.website.id === siteId) ?? null, [state, siteId]);
  const platform = site ? websitePlatform(site.website.platform) : undefined;

  // The chosen site's defaults, and its live categories / authors / blogs.
  useEffect(() => {
    if (!site) return;
    setOpts(site.options);
    setSlugEdited(false);
    setSiteOptions(null);
    if (!when) setWhen(toLocalInput(new Date(Date.now() + 60 * 60_000), state!.timeZone));
    if (site.website.state !== 'connected' && site.website.state !== 'error') return;
    void fetch(`/api/websites/${site.website.id}/options`).then(async (r) => {
      if (r.ok) setSiteOptions((await r.json()) as SiteOptions);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.website.id]);

  if (!state) return null;

  if (state.websites.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" /> Publish to your website
          </CardTitle>
          <CardDescription>
            Not connected. Connect WordPress, Shopify or Ghost and approved blogs publish straight to your site.{' '}
            <Link href="/dashboard/settings/websites" className="font-medium text-primary hover:underline">
              Connect a website
            </Link>
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const set = <K extends keyof PublishOptions>(k: K, v: PublishOptions[K]) => setOpts((o) => (o ? { ...o, [k]: v } : o));
  const pub = site?.publication ?? null;
  const onSite = pub?.state === 'published' || pub?.state === 'drafted';
  const blocked = !site || site.blockers.length > 0 || !state.canPublish;
  const supports = (f: SeoField) => platform?.seo[f].support ?? 'none';

  async function openPreview() {
    if (!site || !opts) return;
    const r = await fetch(`/api/content/drafts/${draftId}/website-publish/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteId: site.website.id, options: opts }),
    });
    const body = (await r.json().catch(() => ({}))) as { html?: string; error?: string };
    if (!r.ok || !body.html) return toast.error(body.error ?? 'Could not build the preview.');
    const hero = state!.featuredImage
      ? `<img src="${escapeHtml(state!.featuredImage.url)}" alt="${escapeHtml(opts.featuredImageAlt)}" style="width:100%;border-radius:8px;margin:12px 0">`
      : '';
    setPreview(
      `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.65 Georgia,serif;max-width:680px;margin:24px auto;padding:0 16px;color:#1f2328}h1{font:700 30px/1.25 system-ui,sans-serif}h2,h3,h4{font-family:system-ui,sans-serif}img{max-width:100%}figure{margin:20px 0}blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px;color:#555}a{color:#0b62d6}.meta{font:13px system-ui,sans-serif;color:#666}</style></head><body><p class="meta">${escapeHtml(site.website.siteUrl.replace(/^https?:\/\//, ''))}/${escapeHtml(opts.slug)}</p><h1>${escapeHtml(opts.title)}</h1>${hero}${body.html}</body></html>`,
    );
  }

  async function submit() {
    if (!site || !opts) return;
    const verb =
      action === 'publish' ? `Publish this blog to ${site.website.name} now?` : action === 'draft' ? `Save this blog as a draft on ${site.website.name}?` : `Schedule this blog for ${site.website.name} at ${when.replace('T', ' ')} (${state!.timeZone})?`;
    if (!window.confirm(onSite ? `${verb} The post already on the site is updated — no second post is created.` : verb)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/content/drafts/${draftId}/website-publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          websiteId: site.website.id,
          action,
          ...(action === 'schedule' ? { scheduledFor: when, scheduleMode } : {}),
          options: opts,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { publication?: PublicationRow; error?: string; details?: Record<string, string[]> };
      if (!res.ok || !body.publication) {
        const detail = body.details ? Object.values(body.details).flat().join(' ') : '';
        toast.error(`${body.error ?? 'Could not publish.'} ${detail}`.trim());
        return;
      }
      const p = body.publication;
      if (p.state === 'published') toast.success(`Published to ${p.websiteName}.`);
      else if (p.state === 'drafted') toast.success(`Saved as a draft on ${p.websiteName}.`);
      else if (p.state === 'scheduled') toast.success(`Scheduled for ${p.websiteName}.`);
      else toast.error(p.errorMessage ?? 'Publishing failed.', { duration: 10_000 });
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, a: 'retry' | 'cancel') {
    setBusy(true);
    await actOnPublication(id, a);
    setBusy(false);
    await load();
    router.refresh();
  }

  const counter = (n: number, max: number) => (
    <span className={`text-xs ${n > max ? 'text-amber-600' : 'text-muted-foreground'}`}>
      {n}/{max}
    </span>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-primary" /> Publish to your website
        </CardTitle>
        <CardDescription>
          Choose the website, check what it receives, then publish, save it as a draft there, or schedule it. Formatting, images and SEO fields go with it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Where it can go, and where it already is. */}
        <div className="space-y-2" role="radiogroup" aria-label="Website">
          {state.websites.map((w) => {
            const href = safeExternalUrl(w.publication?.externalUrl);
            return (
              <label key={w.website.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 ${siteId === w.website.id ? 'border-primary' : 'border-border'}`}>
                <input type="radio" name="website" className="mt-1 h-4 w-4 accent-primary" checked={siteId === w.website.id} onChange={() => setSiteId(w.website.id)} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {w.website.name}
                    <span className="text-xs font-normal text-muted-foreground">{w.website.platformName}</span>
                    <PublishStateBadge state={w.state} />
                  </span>
                  {w.publication?.state === 'scheduled' && w.publication.scheduledFor && (
                    <span className="block text-xs text-muted-foreground">
                      {w.publication.mode === 'draft' ? 'Saved as a draft' : 'Publishes'} {new Date(w.publication.scheduledFor).toLocaleString()}
                    </span>
                  )}
                  {href && (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      {w.state === 'drafted' ? 'Open the draft' : 'View the post'} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {w.publication?.state === 'failed' && w.publication.errorMessage && (
                    <span className="mt-1 flex items-start gap-1.5 text-xs text-foreground">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> {w.publication.errorMessage}
                    </span>
                  )}
                  {w.blockers.length > 0 && w.publication?.state !== 'failed' && (
                    <span className="mt-1 flex items-start gap-1.5 text-xs text-foreground">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" /> {w.blockers.join(' ')}
                    </span>
                  )}
                  {state.canPublish && w.publication && (w.publication.retryable || w.publication.cancellable) && (
                    <span className="mt-2 flex gap-1.5">
                      {w.publication.retryable && w.blockers.length === 0 && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={(e) => (e.preventDefault(), act(w.publication!.id, 'retry'))}>
                          <RotateCw className="h-3.5 w-3.5" /> Retry
                        </Button>
                      )}
                      {w.publication.cancellable && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={(e) => (e.preventDefault(), act(w.publication!.id, 'cancel'))}>
                          <X className="h-3.5 w-3.5" /> Cancel schedule
                        </Button>
                      )}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {site && opts && state.canPublish && (
          <>
            <details className="rounded-md border border-border p-3" open>
              <summary className="cursor-pointer text-sm font-medium text-foreground">Title, URL &amp; SEO</summary>
              <div className="mt-3 grid gap-3">
                <div className="space-y-1">
                  <Label htmlFor="wp-title">Title</Label>
                  <Input
                    id="wp-title"
                    value={opts.title}
                    onChange={(e) => {
                      set('title', e.target.value);
                      if (!slugEdited) set('slug', slugify(e.target.value));
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-slug">URL slug</Label>
                  <Input
                    id="wp-slug"
                    value={opts.slug}
                    onChange={(e) => {
                      setSlugEdited(true);
                      set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-seotitle" className="flex justify-between">
                    SEO title {counter(opts.seoTitle.length, SEO_TITLE_MAX)}
                  </Label>
                  <Input id="wp-seotitle" value={opts.seoTitle} onChange={(e) => set('seoTitle', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-meta" className="flex justify-between">
                    Meta description {counter(opts.metaDescription.length, META_DESCRIPTION_MAX)}
                  </Label>
                  <Textarea id="wp-meta" rows={3} value={opts.metaDescription} onChange={(e) => set('metaDescription', e.target.value)} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="wp-kw">Focus keyphrase</Label>
                    <Input id="wp-kw" value={opts.focusKeyword} onChange={(e) => set('focusKeyword', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="wp-canonical">Canonical URL</Label>
                    <Input
                      id="wp-canonical"
                      placeholder="https://… (optional)"
                      disabled={supports('canonicalUrl') === 'none'}
                      value={opts.canonicalUrl}
                      onChange={(e) => set('canonicalUrl', e.target.value)}
                    />
                  </div>
                </div>
                {state.featuredImage && (
                  <div className="space-y-1">
                    <Label htmlFor="wp-alt">Featured image alt text</Label>
                    <Input id="wp-alt" value={opts.featuredImageAlt} onChange={(e) => set('featuredImageAlt', e.target.value)} />
                  </div>
                )}
                {platform && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {(Object.keys(platform.seo) as SeoField[])
                      .filter((f) => platform.seo[f].support !== 'native')
                      .map((f) => (
                        <li key={f}>
                          {SEO_FIELD_LABELS[f]}: {platform.seo[f].note ?? (platform.seo[f].support === 'none' ? `${platform.name} has no field for it.` : '')}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </details>

            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">Categories, tags, author &amp; internal links</summary>
              <div className="mt-3 grid gap-3">
                {siteOptions?.blogs ? (
                  <div className="space-y-1">
                    <Label htmlFor="wp-blog">Blog</Label>
                    <select id="wp-blog" className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={opts.blogId} onChange={(e) => set('blogId', e.target.value)}>
                      {siteOptions.blogs.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {platform?.categories !== 'none' && (
                  <div className="space-y-1">
                    <Label htmlFor="wp-cats">{platform?.id === 'ghost' ? 'Primary tag' : 'Categories'}</Label>
                    <TagInput id="wp-cats" value={opts.categories} onChange={(v) => set('categories', v)} placeholder="Type and press Enter" />
                    {siteOptions?.categories && siteOptions.categories.length > 0 && (
                      <p className="flex flex-wrap gap-1 text-xs">
                        {siteOptions.categories
                          .filter((c) => !opts.categories.includes(c.name))
                          .slice(0, 12)
                          .map((c) => (
                            <button key={c.id} type="button" className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => set('categories', [...opts.categories, c.name])}>
                              + {c.name}
                            </button>
                          ))}
                      </p>
                    )}
                    {platform?.id === 'shopify' && <p className="text-xs text-muted-foreground">Shopify has no categories — these are added as tags.</p>}
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="wp-tags">Tags</Label>
                  <TagInput id="wp-tags" value={opts.tags} onChange={(v) => set('tags', v)} placeholder="Type and press Enter" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wp-author">Author</Label>
                  {siteOptions?.authors?.length ? (
                    <select id="wp-author" className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={opts.author} onChange={(e) => set('author', e.target.value)}>
                      <option value="">Site default</option>
                      {siteOptions.authors.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input id="wp-author" value={opts.author} onChange={(e) => set('author', e.target.value)} placeholder="Author name" />
                  )}
                </div>
                {siteOptions?.recentPosts && siteOptions.recentPosts.length > 0 && (
                  <fieldset className="space-y-1">
                    <legend className="text-sm font-medium text-foreground">Internal links</legend>
                    <p className="text-xs text-muted-foreground">Pick posts from {site.website.name} to link under “Related reading”. Links already in the blog are kept.</p>
                    {siteOptions.recentPosts.slice(0, 10).map((p) => {
                      const on = opts.relatedLinks.some((l) => l.url === p.url);
                      return (
                        <label key={p.url} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-primary"
                            checked={on}
                            onChange={() => set('relatedLinks', on ? opts.relatedLinks.filter((l) => l.url !== p.url) : [...opts.relatedLinks, { title: p.title, url: p.url }].slice(0, 10))}
                          />
                          {p.title}
                        </label>
                      );
                    })}
                  </fieldset>
                )}
              </div>
            </details>

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How to publish">
                {(
                  [
                    ['publish', 'Publish now', Send],
                    ...(platform?.supportsDraft ? [['draft', 'Save as draft', FileText] as const] : []),
                    ['schedule', 'Schedule for later', CalendarClock],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={action === key}
                    onClick={() => setAction(key as Action)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${action === key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>
              {action === 'schedule' && (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="wp-when">When ({state.timeZone})</Label>
                    <Input id="wp-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                  </div>
                  {platform?.supportsDraft && (
                    <select aria-label="Scheduled as" className="h-10 rounded-md border border-input bg-background px-2 text-sm" value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value as 'publish' | 'draft')}>
                      <option value="publish">Published post</option>
                      <option value="draft">Draft on the site</option>
                    </select>
                  )}
                </div>
              )}
            </div>

            {pub?.seoReport && Object.keys(pub.seoReport).length > 0 && (pub.state === 'published' || pub.state === 'drafted') && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">What {site.website.name} kept last time</summary>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {Object.entries(pub.seoReport).map(([k, v]) => (
                    <li key={k}>
                      {SEO_FIELD_LABELS[k as SeoField] ?? k}: {OUTCOME_LABEL[v.outcome] ?? v.outcome}
                      {v.note ? ` — ${v.note}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={openPreview}>
                <Eye className="h-4 w-4" /> Preview
              </Button>
              <Button className="flex-1" loading={busy} disabled={blocked} onClick={submit}>
                {action === 'publish' ? <Send className="h-4 w-4" /> : action === 'draft' ? <FileText className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}
                {action === 'publish'
                  ? `${onSite ? 'Update' : 'Publish'} on ${site.website.name}`
                  : action === 'draft'
                    ? `Save as draft on ${site.website.name}`
                    : `Schedule for ${site.website.name}`}
              </Button>
            </div>
            {!state.approved && (
              <p className="text-xs text-muted-foreground">
                Only approved blogs are published.{' '}
                <Link href={`/dashboard/review/content/${draftId}`} className="font-medium text-primary hover:underline">
                  Review &amp; approve
                </Link>
              </p>
            )}
          </>
        )}
        {!state.canPublish && <p className="text-xs text-muted-foreground">Only owners and admins can publish to websites.</p>}
      </CardContent>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview — {site?.website.name}</DialogTitle>
            <DialogDescription>The content exactly as it is sent. Your site’s theme styles it there.</DialogDescription>
          </DialogHeader>
          {preview && <iframe title="Blog preview" sandbox="" srcDoc={preview} className="h-[65vh] w-full rounded-md border border-border bg-white" />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
