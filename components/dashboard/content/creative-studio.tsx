'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Download,
  ImageIcon,
  Info,
  Paintbrush,
  RefreshCw,
  Sparkles,
  Wand2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import {
  CREATIVE_FORMATS,
  CREATIVE_TYPE_LABEL,
  CREATIVE_TYPES,
  FONT_PAIR_LABEL,
  FONT_PAIRS,
  LAYOUT_LABEL,
  LAYOUTS,
  PHOTO_MOOD_LABEL,
  PHOTO_MOODS,
  type CreativeSpec,
  type TextSource,
} from '@/lib/creative/spec';

/**
 * The marketing creative studio: a real photograph, the business's brand and
 * the campaign's words, composed into a ready-to-post design
 * (server/media/creative). Text is set by Aura's layout renderer — edit it
 * and re-set the design in a second, without making a new photo.
 */

interface AssetLite {
  id: string;
  url: string;
  width: number;
  height: number;
  attached: boolean;
  createdAt: string;
  mimeType: string;
  creative: {
    type: string;
    layout: string;
    headline: string;
    photoAssetId: string | null;
    fallback: boolean;
    fallbackReason: string | null;
  } | null;
}
interface Data {
  creatives: { asset: AssetLite; spec: CreativeSpec | null }[];
  photos: AssetLite[];
  brand: {
    name: string;
    colors: { primary: string; secondary: string; accent: string };
    hasLogo: boolean;
    website: string | null;
  };
  providerConfigured: boolean;
  activeJob: { jobId: string; status: string } | null;
}

type Form = {
  type: string;
  layout: string;
  aspectRatio: '1:1' | '4:5' | '9:16' | '16:9';
  fontPair: string;
  mood: string;
  headline: string;
  subheadline: string;
  eyebrow: string;
  eventName: string;
  date: string;
  time: string;
  venue: string;
  offer: string;
  cta: string;
  website: string;
  showLogo: boolean;
  primary: string;
  accent: string;
  photoDirection: string;
};

const EMPTY: Form = {
  type: '',
  layout: '',
  aspectRatio: '1:1',
  fontPair: '',
  mood: '',
  headline: '',
  subheadline: '',
  eyebrow: '',
  eventName: '',
  date: '',
  time: '',
  venue: '',
  offer: '',
  cta: '',
  website: '',
  showLogo: true,
  primary: '',
  accent: '',
  photoDirection: '',
};

const SOURCE_LABEL: Record<TextSource, string> = {
  you: 'from you',
  'your request': 'from your request',
  'your post': 'from your post',
  business: 'from your business details',
  aura: 'written by Aura',
};
const FIELD_LABEL: Record<string, string> = {
  headline: 'Headline',
  subheadline: 'Supporting line',
  eyebrow: 'Kicker',
  date: 'Date',
  time: 'Time',
  venue: 'Venue',
  offer: 'Offer',
  cta: 'Call to action',
  website: 'Website',
};

const select =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {children}
      </label>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const or = (v: string) => (v.trim() ? v.trim() : undefined);

export function CreativeStudio({
  draftId,
  canEdit,
}: {
  draftId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [current, setCurrent] = useState<{
    asset: AssetLite;
    spec: CreativeSpec | null;
  } | null>(null);
  const [photo, setPhoto] = useState<{
    mode: 'new' | 'reuse' | 'none';
    assetId?: string;
  }>({ mode: 'new' });
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ warnings: string[]; removed: string[] }>(
    { warnings: [], removed: [] },
  );
  const polling = useRef(false);

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /** Load a creative's design into the form, so edits build on it. */
  const adopt = useCallback(
    (c: { asset: AssetLite; spec: CreativeSpec | null }) => {
      setCurrent(c);
      const s = c.spec;
      if (!s) return;
      setForm((f) => ({
        ...f,
        type: s.type,
        layout: s.layout,
        aspectRatio: s.aspectRatio as Form['aspectRatio'],
        fontPair: s.fontPair,
        mood: s.mood,
        headline: s.text.headline,
        subheadline: s.text.subheadline ?? '',
        eyebrow: s.text.eyebrow ?? '',
        date: s.text.date ?? '',
        time: s.text.time ?? '',
        venue: s.text.venue ?? '',
        offer: s.text.offer ?? '',
        cta: s.text.cta ?? '',
        website: s.text.website ?? '',
        showLogo: s.brand.showLogo,
        primary: s.brand.colors.primary,
        accent: s.brand.colors.accent,
        photoDirection: s.photo.direction ?? '',
      }));
      setPhoto(
        s.photo.assetId
          ? { mode: 'reuse', assetId: s.photo.assetId }
          : { mode: 'none' },
      );
    },
    [],
  );

  const load = useCallback(
    async (select?: string) => {
      const res = await fetch(`/api/content/drafts/${draftId}/creative`);
      if (!res.ok) return null;
      const d = (await res.json()) as Data;
      setData(d);
      const pick =
        d.creatives.find((c) => c.asset.id === select) ??
        (select ? null : d.creatives[0]);
      if (pick) adopt(pick);
      return d;
    },
    [draftId, adopt],
  );

  const poll = useCallback(
    async (jobId: string) => {
      if (polling.current) return;
      polling.current = true;
      setBusy('generate');
      void fetch(`/api/jobs/${jobId}/run`, { method: 'POST' }).catch(
        () => undefined,
      );
      try {
        for (let i = 0; i < 160; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const r = await fetch(`/api/jobs/${jobId}`);
          if (!r.ok) continue;
          const j = (await r.json()) as {
            status: string;
            progress?: { message?: string } | null;
            error?: string | null;
            result?: {
              creative?: {
                asset: AssetLite;
                spec: CreativeSpec;
                warnings: string[];
                removed: string[];
              };
            } | null;
          };
          setProgress(j.progress?.message ?? null);
          if (j.status === 'SUCCEEDED' && j.result?.creative) {
            const c = j.result.creative;
            setNotes({ warnings: c.warnings, removed: c.removed });
            await load(c.asset.id);
            toast.success(
              c.spec.photo.fallback
                ? 'Creative made on your brand background (no AI photo).'
                : 'Creative ready.',
            );
            return;
          }
          if (j.status === 'FAILED') {
            toast.error(j.error ?? 'The creative could not be made.');
            return;
          }
          if (j.status === 'QUEUED' && i % 8 === 7)
            void fetch(`/api/jobs/${jobId}/run`, { method: 'POST' }).catch(
              () => undefined,
            );
        }
        toast.error(
          'This is taking longer than expected — reload in a minute to see it.',
        );
      } finally {
        polling.current = false;
        setBusy(null);
        setProgress(null);
      }
    },
    [load],
  );

  useEffect(() => {
    void load().then((d) => {
      if (d?.activeJob) void poll(d.activeJob.jobId);
    });
  }, [load, poll]);

  const input = (mode: 'new' | 'reuse' | 'none', assetId?: string) => ({
    ...(form.type ? { type: form.type } : {}),
    ...(form.layout ? { layout: form.layout } : {}),
    aspectRatio: form.aspectRatio,
    ...(form.fontPair ? { fontPair: form.fontPair } : {}),
    ...(form.mood ? { mood: form.mood } : {}),
    headline: or(form.headline),
    subheadline: or(form.subheadline),
    eyebrow: or(form.eyebrow),
    eventName: or(form.eventName),
    date: or(form.date),
    time: or(form.time),
    venue: or(form.venue),
    offer: or(form.offer),
    cta: or(form.cta),
    website: or(form.website),
    showLogo: form.showLogo,
    colors: {
      ...(or(form.primary) ? { primary: form.primary } : {}),
      ...(or(form.accent) ? { accent: form.accent } : {}),
    },
    photoDirection: or(form.photoDirection),
    photo: mode,
    ...(assetId ? { photoAssetId: assetId } : {}),
  });

  /** The words exactly as they stand in the form. */
  const keepText = () => {
    const prev = current?.spec?.sources ?? {};
    const prevText = current?.spec?.text;
    const text = {
      eyebrow: or(form.eyebrow) ?? null,
      headline: form.headline.trim(),
      subheadline: or(form.subheadline) ?? null,
      date: or(form.date) ?? null,
      time: or(form.time) ?? null,
      venue: or(form.venue) ?? null,
      offer: or(form.offer) ?? null,
      cta: or(form.cta) ?? null,
      website: or(form.website) ?? null,
    };
    // Unchanged words keep where they came from; edited words are the person's.
    const sources: Record<string, TextSource> = {};
    for (const [k, v] of Object.entries(text)) {
      if (!v) continue;
      sources[k] =
        prevText &&
        (prevText as unknown as Record<string, string | null>)[k] === v &&
        prev[k as keyof typeof prev]
          ? prev[k as keyof typeof prev]!
          : 'you';
    }
    return {
      type: (form.type ||
        current?.spec?.type ||
        'brand_awareness') as CreativeSpec['type'],
      text,
      sources,
    };
  };

  async function generate(keep: boolean) {
    if (keep && !form.headline.trim()) {
      toast.error('Add a headline first.');
      return;
    }
    setBusy('generate');
    setNotes({ warnings: [], removed: [] });
    const res = await fetch(`/api/content/drafts/${draftId}/creative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: input(
          keep ? 'new' : photo.mode === 'reuse' ? 'reuse' : photo.mode,
          photo.assetId,
        ),
        keepText: keep ? keepText() : null,
      }),
    });
    const d = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      error?: string;
    };
    if (!res.ok || !d.jobId) {
      setBusy(null);
      toast.error(d.error ?? 'Could not start the creative.');
      return;
    }
    await poll(d.jobId);
  }

  async function rerender() {
    if (!form.headline.trim()) {
      toast.error('Add a headline first.');
      return;
    }
    setBusy('render');
    try {
      const reuse = photo.mode === 'reuse' && photo.assetId;
      const res = await fetch(
        `/api/content/drafts/${draftId}/creative/render`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: input(
              reuse ? 'reuse' : 'none',
              reuse ? photo.assetId : undefined,
            ),
            keepText: keepText(),
          }),
        },
      );
      const d = (await res.json().catch(() => ({}))) as {
        asset?: AssetLite;
        warnings?: string[];
        removed?: string[];
        error?: string;
      };
      if (!res.ok || !d.asset) {
        toast.error(d.error ?? 'Could not update the design.');
        return;
      }
      setNotes({ warnings: d.warnings ?? [], removed: [] });
      await load(d.asset.id);
      toast.success('Design updated.');
    } finally {
      setBusy(null);
    }
  }

  async function attach() {
    if (!current) return;
    setBusy('attach');
    try {
      const alt = [current.spec?.text.headline, current.spec?.text.subheadline]
        .filter(Boolean)
        .join(' — ');
      const res = await fetch(
        `/api/content/graphics/${current.asset.id}/attach`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draftId,
            replace: true,
            altText: alt.slice(0, 300),
          }),
        },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(d.error ?? 'Could not attach it.');
        return;
      }
      toast.success(
        'Attached to the post. It still needs approval before anything is published.',
      );
      await load(current.asset.id);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const spec = current?.spec ?? null;
  const fmt = CREATIVE_FORMATS[form.aspectRatio];
  const disabled = !canEdit || busy !== null;

  return (
    <Card data-testid="creative-studio">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Paintbrush className="h-4 w-4 text-primary" aria-hidden />{' '}
              Marketing creative
            </h2>
            <p className="text-xs text-muted-foreground">
              A real photograph, your brand and the campaign’s words, set in
              professional typography — ready to post after approval.
            </p>
          </div>
          {data && !data.providerConfigured && (
            <Badge variant="warning">
              No image provider — brand background only
            </Badge>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Preview */}
          <div className="min-w-0 space-y-3">
            <div
              className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border bg-muted/40"
              style={{
                aspectRatio: current
                  ? `${current.asset.width} / ${current.asset.height}`
                  : `${fmt.width} / ${fmt.height}`,
              }}
            >
              {current ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.asset.url}
                  alt={spec?.text.headline ?? 'Marketing creative'}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  <ImageIcon className="mx-auto mb-2 h-6 w-6" aria-hidden />
                  No creative yet. Fill in what you know — Aura writes the rest
                  — and generate.
                </div>
              )}
              {busy === 'generate' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 text-sm text-foreground">
                  <RefreshCw className="h-5 w-5 animate-spin" aria-hidden />
                  {progress ?? 'Starting…'}
                </div>
              )}
            </div>
            {current?.asset.creative && (
              <div
                className="space-y-1.5 text-xs"
                data-testid="creative-provenance"
              >
                {current.asset.creative.fallback ? (
                  <p className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    Brand background — no AI photo was made (
                    {current.asset.creative.fallbackReason ?? 'unavailable'}).
                    This is a design on your colours, not a photograph.
                  </p>
                ) : !current.asset.creative.photoAssetId ? (
                  <p className="text-muted-foreground">
                    Set on your brand background.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Photograph generated by AI for this creative; all text set
                    by Aura’s layout engine.
                  </p>
                )}
                {spec && (
                  <p className="text-muted-foreground">
                    {Object.entries(spec.sources)
                      .map(
                        ([k, v]) =>
                          `${FIELD_LABEL[k] ?? k} ${SOURCE_LABEL[v as TextSource]}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                {notes.removed.length > 0 && (
                  <p className="flex gap-1 text-muted-foreground">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{' '}
                    Left out — never invented: {notes.removed.join('; ')}.
                  </p>
                )}
                {notes.warnings.map((w) => (
                  <p key={w} className="text-amber-700 dark:text-amber-300">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {current && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={attach}
                  disabled={disabled || current.asset.attached}
                  loading={busy === 'attach'}
                >
                  <Check className="h-4 w-4" />{' '}
                  {current.asset.attached
                    ? 'Attached to the post'
                    : 'Use on this post'}
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a
                    href={current.asset.url}
                    download={`creative-${current.asset.id}.png`}
                  >
                    <Download className="h-4 w-4" /> Download
                  </a>
                </Button>
              </div>
            )}
            {data && data.creatives.length > 1 && (
              <div
                className="flex gap-2 overflow-x-auto pb-1"
                aria-label="Earlier creatives"
              >
                {data.creatives.map((c) => (
                  <button
                    key={c.asset.id}
                    type="button"
                    onClick={() => adopt(c)}
                    className={cn(
                      'h-16 w-16 shrink-0 overflow-hidden rounded-md border',
                      current?.asset.id === c.asset.id
                        ? 'ring-2 ring-primary'
                        : 'opacity-80 hover:opacity-100',
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.asset.url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Creative type">
                <select
                  className={select}
                  value={form.type}
                  onChange={(e) => set('type', e.target.value)}
                  disabled={disabled}
                >
                  <option value="">Choose for me</option>
                  {CREATIVE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CREATIVE_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Format">
                <select
                  className={select}
                  value={form.aspectRatio}
                  onChange={(e) =>
                    set('aspectRatio', e.target.value as Form['aspectRatio'])
                  }
                  disabled={disabled}
                >
                  {(Object.keys(CREATIVE_FORMATS) as Form['aspectRatio'][]).map(
                    (k) => (
                      <option key={k} value={k}>
                        {CREATIVE_FORMATS[k].label}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="Layout">
                <select
                  className={select}
                  value={form.layout}
                  onChange={(e) => set('layout', e.target.value)}
                  disabled={disabled}
                >
                  <option value="">Choose for me</option>
                  {LAYOUTS.map((l) => (
                    <option key={l} value={l}>
                      {LAYOUT_LABEL[l]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Typography">
                <select
                  className={select}
                  value={form.fontPair}
                  onChange={(e) => set('fontPair', e.target.value)}
                  disabled={disabled}
                >
                  <option value="">Match my brand</option>
                  {FONT_PAIRS.map((p) => (
                    <option key={p} value={p}>
                      {FONT_PAIR_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="Headline"
              hint="Leave the words empty and Aura writes them from your post — set them and they are used exactly."
            >
              <Input
                value={form.headline}
                onChange={(e) => set('headline', e.target.value)}
                maxLength={80}
                disabled={disabled}
                placeholder="e.g. Annual Business Summit 2026"
              />
            </Field>
            <Field label="Supporting line">
              <Input
                value={form.subheadline}
                onChange={(e) => set('subheadline', e.target.value)}
                maxLength={140}
                disabled={disabled}
                placeholder="e.g. Innovate. Connect. Grow."
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Event or campaign name">
                <Input
                  value={form.eventName}
                  onChange={(e) => set('eventName', e.target.value)}
                  maxLength={80}
                  disabled={disabled}
                />
              </Field>
              <Field label="Kicker (small line above)">
                <Input
                  value={form.eyebrow}
                  onChange={(e) => set('eyebrow', e.target.value)}
                  maxLength={40}
                  disabled={disabled}
                />
              </Field>
              <Field label="Date">
                <Input
                  value={form.date}
                  onChange={(e) => set('date', e.target.value)}
                  maxLength={60}
                  disabled={disabled}
                  placeholder="November 15, 2026"
                />
              </Field>
              <Field label="Time">
                <Input
                  value={form.time}
                  onChange={(e) => set('time', e.target.value)}
                  maxLength={40}
                  disabled={disabled}
                />
              </Field>
              <Field label="Venue / location">
                <Input
                  value={form.venue}
                  onChange={(e) => set('venue', e.target.value)}
                  maxLength={100}
                  disabled={disabled}
                />
              </Field>
              <Field label="Offer or price">
                <Input
                  value={form.offer}
                  onChange={(e) => set('offer', e.target.value)}
                  maxLength={40}
                  disabled={disabled}
                  placeholder="e.g. 20% OFF"
                />
              </Field>
              <Field label="Call to action">
                <Input
                  value={form.cta}
                  onChange={(e) => set('cta', e.target.value)}
                  maxLength={30}
                  disabled={disabled}
                  placeholder="e.g. Register now"
                />
              </Field>
              <Field label="Website (optional)">
                <Input
                  value={form.website}
                  onChange={(e) => set('website', e.target.value)}
                  maxLength={80}
                  disabled={disabled}
                  placeholder={data?.brand.website ?? ''}
                />
              </Field>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Dates, times, venues, prices and offers appear only as you give
              them (here or in your request) — Aura never invents them.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Brand colour">
                <div className="flex gap-2">
                  <input
                    type="color"
                    aria-label="Brand colour"
                    className="h-9 w-10 rounded border"
                    value={
                      form.primary || data?.brand.colors.primary || '#14213D'
                    }
                    onChange={(e) => set('primary', e.target.value)}
                    disabled={disabled}
                  />
                  <Input
                    value={form.primary}
                    onChange={(e) => set('primary', e.target.value)}
                    placeholder={data?.brand.colors.primary}
                    disabled={disabled}
                  />
                </div>
              </Field>
              <Field label="Accent colour">
                <div className="flex gap-2">
                  <input
                    type="color"
                    aria-label="Accent colour"
                    className="h-9 w-10 rounded border"
                    value={
                      form.accent || data?.brand.colors.accent || '#F5B700'
                    }
                    onChange={(e) => set('accent', e.target.value)}
                    disabled={disabled}
                  />
                  <Input
                    value={form.accent}
                    onChange={(e) => set('accent', e.target.value)}
                    placeholder={data?.brand.colors.accent}
                    disabled={disabled}
                  />
                </div>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.showLogo}
                onChange={(e) => set('showLogo', e.target.checked)}
                disabled={disabled}
              />
              {data?.brand.hasLogo
                ? 'Show my logo'
                : 'Show my business name (add a logo in Settings → Brand)'}
            </label>

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Photograph
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={photo.mode === 'new'}
                    onChange={() => setPhoto({ mode: 'new' })}
                    disabled={disabled}
                  />{' '}
                  New AI photo
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={photo.mode === 'reuse'}
                    onChange={() =>
                      setPhoto({
                        mode: 'reuse',
                        assetId:
                          current?.asset.creative?.photoAssetId ??
                          data?.photos[0]?.id,
                      })
                    }
                    disabled={
                      disabled ||
                      !(
                        data?.photos.length ||
                        current?.asset.creative?.photoAssetId
                      )
                    }
                  />{' '}
                  One of my images
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={photo.mode === 'none'}
                    onChange={() => setPhoto({ mode: 'none' })}
                    disabled={disabled}
                  />{' '}
                  Brand background
                </label>
              </div>
              {photo.mode === 'new' && (
                <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
                  <Input
                    value={form.photoDirection}
                    onChange={(e) => set('photoDirection', e.target.value)}
                    maxLength={300}
                    disabled={disabled}
                    placeholder="Photo direction (optional): e.g. a barista pouring latte art"
                  />
                  <select
                    className={select}
                    value={form.mood}
                    onChange={(e) => set('mood', e.target.value)}
                    disabled={disabled}
                    aria-label="Light"
                  >
                    <option value="">Light: auto</option>
                    {PHOTO_MOODS.map((m) => (
                      <option key={m} value={m}>
                        {PHOTO_MOOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {photo.mode === 'reuse' && data && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {data.photos.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPhoto({ mode: 'reuse', assetId: p.id })}
                      className={cn(
                        'h-14 w-14 shrink-0 overflow-hidden rounded border',
                        photo.assetId === p.id
                          ? 'ring-2 ring-primary'
                          : 'opacity-80',
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => generate(false)}
                  loading={busy === 'generate'}
                  disabled={disabled}
                >
                  <Sparkles className="h-4 w-4" />{' '}
                  {current ? 'Generate a new creative' : 'Generate creative'}
                </Button>
                {current && (
                  <>
                    <Button
                      variant="outline"
                      onClick={rerender}
                      loading={busy === 'render'}
                      disabled={disabled}
                    >
                      <Wand2 className="h-4 w-4" /> Update text &amp; design
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => generate(true)}
                      disabled={disabled}
                    >
                      <RefreshCw className="h-4 w-4" /> New photo, keep text
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
