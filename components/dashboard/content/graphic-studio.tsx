'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Image as ImageIcon,
  Sparkles,
  RotateCcw,
  Download,
  Check,
  Trash2,
  AlertTriangle,
  Wand2,
  History,
  Upload,
  Link as LinkIcon,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import {
  ASPECT_RATIOS,
  type AspectRatioKey,
  type SocialPlatformKey,
} from '@/lib/platforms';
import {
  IMAGE_STYLES,
  type ImageStyleKey,
  type FormatChoice,
  CUSTOM_FORMAT,
  STYLE_LABELS,
  FORMAT_LABELS,
  FORMAT_HINTS,
  aspectClass,
  formatFileSize,
  groupByDay,
} from '@/lib/graphics-ui';

/**
 * Content Studio → Graphic Generation.
 *
 * The flow this component implements, in order: read the post → write a prompt
 * from it → let the user edit that prompt → generate variations → pick one →
 * attach it to the post. Each step is visible and reversible, because the whole
 * value proposition is that the user stays in control of what gets published.
 *
 * Deliberate choices worth knowing about:
 *   - The prompt is generated on demand, not on mount. Opening a draft should
 *     never quietly spend an LLM call.
 *   - `busy` is a single ref-backed guard rather than per-button state: image
 *     generation is the one action here that costs real money, and a double
 *     click must not become a double charge.
 *   - Provider status is fetched once and drives the selector, so an
 *     unconfigured provider says what to add instead of failing on submit.
 */
interface ProviderStatus {
  id: string;
  label: string;
  model: string;
  description: string;
  configured: boolean;
  credentialEnv: string;
  supportedRatios: AspectRatioKey[];
  maxImagesPerRequest: number;
}

interface Usage {
  used: number;
  limit: number;
  remaining: number;
  maxPerRequest: number;
  plan: string;
}

export interface GraphicAsset {
  id: string;
  url: string;
  provider: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  attached: boolean;
}

interface Props {
  draftId: string;
  platform: SocialPlatformKey;
  platformLabel: string;
  defaultRatio: AspectRatioKey;
  /** Graphics already generated for this draft, rendered before any new work. */
  initialAssets: GraphicAsset[];
  /** Ids currently attached, so the gallery marks the right tile. */
  attachedAssetIds: string[];
  /**
   * A generation already in flight for this draft, from the server render.
   *
   * Generation outlives the page: the run completes server-side even if the tab
   * is closed. Without this, reloading mid-run showed an idle panel while
   * images were still being made, and the user had no way to tell.
   */
  activeJobId: string | null;
  canEdit: boolean;
}

type Phase =
  | 'idle'
  | 'analyzing'
  | 'prompting'
  | 'generating'
  | 'preparing';

/**
 * Polling cadence for a queued generation.
 *
 * 1.5s matches what the other job-backed screens use. The ceiling is generous
 * because four variations on a slow provider genuinely can take minutes — and
 * giving up on the poll does not cancel the run, so the copy says so.
 */
const JOB_POLL_MS = 1500;
const JOB_TIMEOUT_MS = 6 * 60 * 1000;

const PHASE_STEPS: Array<{ key: Phase; label: string }> = [
  { key: 'analyzing', label: 'Analyzing content' },
  { key: 'prompting', label: 'Creating image prompt' },
  { key: 'generating', label: 'Generating image' },
  { key: 'preparing', label: 'Preparing preview' },
];

export function GraphicStudio({
  draftId,
  platform,
  platformLabel,
  defaultRatio,
  initialAssets,
  attachedAssetIds,
  activeJobId,
  canEdit,
}: Props) {
  const router = useRouter();

  // An in-flight run means the panel opens expanded and busy, even on a cold
  // page load, so a reload never looks like the generation was lost.
  const [open, setOpen] = useState(initialAssets.length > 0 || Boolean(activeJobId));
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [provider, setProvider] = useState<string>('');

  const [prompt, setPrompt] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [subject, setSubject] = useState('');
  const [promptSource, setPromptSource] = useState<'ai' | 'heuristic' | null>(null);

  const [format, setFormat] = useState<FormatChoice>(defaultRatio);
  const [customWidth, setCustomWidth] = useState(1080);
  const [customHeight, setCustomHeight] = useState(1350);
  const [style, setStyle] = useState<ImageStyleKey>('professional');
  const [variations, setVariations] = useState(1);

  const [assets, setAssets] = useState<GraphicAsset[]>(initialAssets);
  const [attached, setAttached] = useState<Set<string>>(
    new Set(attachedAssetIds),
  );
  const [selected, setSelected] = useState<string | null>(
    attachedAssetIds[0] ?? null,
  );

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; provider?: string } | null>(
    null,
  );
  const [showHistory, setShowHistory] = useState(false);
  /** null = not loaded yet. Company-wide, loaded lazily — see toggleHistory. */
  const [history, setHistory] = useState<GraphicAsset[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Supplying an existing graphic (file or URL) rather than generating one.
  const [uploading, setUploading] = useState<'file' | 'url' | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * The in-flight guard.
   *
   * A ref rather than state because it must be correct synchronously, within
   * the same click handler — a state update would not have landed yet when a
   * second click arrives a few milliseconds later.
   */
  const inFlight = useRef(false);

  // Provider status loads when the panel is first opened, not on mount: a user
  // reading a draft has not asked for anything yet.
  useEffect(() => {
    if (!open || providers.length > 0) return;
    let cancelled = false;
    fetch('/api/content/graphics/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const list: ProviderStatus[] = data.providers ?? [];
        setProviders(list);
        setUsage(data.usage ?? null);
        setProvider((prev) => prev || (list.find((p) => p.configured)?.id ?? ''));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, providers.length]);

  /**
   * Reattach to a run that was already going when this page loaded.
   *
   * Runs once, and only when the server told us there is one. `inFlight` is
   * claimed first so the Generate button is correctly disabled while we are
   * merely watching someone else's (or our own earlier) run.
   */
  useEffect(() => {
    if (!activeJobId || inFlight.current) return;
    inFlight.current = true;
    setPhase('generating');
    void pollJob(activeJobId).finally(() => {
      inFlight.current = false;
      setPhase('idle');
    });
    // Deliberately only on mount for the job the server reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  const activeProvider = providers.find((p) => p.id === provider) ?? null;
  const anyConfigured = providers.some((p) => p.configured);
  const maxVariations = Math.min(
    usage?.maxPerRequest ?? 4,
    activeProvider?.maxImagesPerRequest ?? 4,
  );

  const writePrompt = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPhase('analyzing');
    try {
      // Two labelled steps for one request. The analysis and the prompt writing
      // genuinely are two things the model does, and the pause between them is
      // long enough that a single static label reads as a hang.
      const request = fetch(`/api/content/drafts/${draftId}/graphics/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, platform }),
      });
      const timer = setTimeout(() => setPhase('prompting'), 900);
      const res = await request;
      clearTimeout(timer);

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError({ message: body.error ?? 'Could not write an image prompt.' });
        return;
      }
      const data = (await res.json()) as {
        prompt: string;
        negativePrompt: string;
        subject: string;
        source: 'ai' | 'heuristic';
      };
      setPrompt(data.prompt);
      setAiPrompt(data.prompt);
      setNegativePrompt(data.negativePrompt);
      setSubject(data.subject);
      setPromptSource(data.source);
    } catch {
      setError({ message: 'Could not reach the server. Try again.' });
    } finally {
      inFlight.current = false;
      setPhase('idle');
    }
  }, [draftId, style, platform]);

  async function openStudio() {
    setOpen(true);
    if (!prompt) await writePrompt();
  }

  /**
   * Queue a generation, then poll it.
   *
   * Generation runs as a background job (see the route), so this does not wait
   * on one long request that a serverless platform would kill. It queues, kicks
   * the runner without awaiting it, and polls for progress — the same pattern
   * the trend digest and the monthly planner already use.
   */
  async function generate() {
    if (inFlight.current) return;
    if (prompt.trim().length < 20) {
      toast.error('The image prompt needs a bit more to work with.');
      return;
    }
    inFlight.current = true;
    setError(null);
    setPhase('generating');
    try {
      const res = await fetch(`/api/content/drafts/${draftId}/graphics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          originalPrompt: aiPrompt || undefined,
          provider: provider || undefined,
          // Custom sends dimensions instead of a ratio; the backend maps them
          // to the closest shape the chosen provider can draw.
          ...(format === CUSTOM_FORMAT
            ? { customWidth, customHeight }
            : { aspectRatio: format }),
          style,
          variations,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError({
          message: body.error ?? 'Image generation failed.',
          ...(activeProvider ? { provider: activeProvider.label } : {}),
        });
        return;
      }

      const queued = (await res.json()) as {
        jobId: string;
        reused?: boolean;
        planNote?: string;
      };
      if (queued.planNote) toast(queued.planNote, { duration: 7000 });

      // Fire and forget: nobody waits on this response, and the run completes
      // server-side even if the tab is closed. A `reused` job already has a
      // runner attached, so kicking it again would be a wasted request.
      if (!queued.reused) {
        void fetch(`/api/jobs/${queued.jobId}/run`, { method: 'POST' }).catch(
          () => undefined,
        );
      }

      await pollJob(queued.jobId);
    } catch {
      setError({ message: 'Could not reach the server. Your content is safe — try again.' });
    } finally {
      inFlight.current = false;
      setPhase('idle');
    }
  }

  /** Poll until the job finishes, applying its result or its error. */
  async function pollJob(jobId: string) {
    const deadline = Date.now() + JOB_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));

      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) continue; // a blip mid-run is not a failed generation

      const job = (await res.json()) as {
        status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
        progress?: { percent?: number };
        result?: {
          assets?: GraphicAsset[];
          substitutedFrom?: string;
          aspectRatio?: string;
          warning?: string;
        };
        error?: string | null;
      };

      // The runner reports 90% once it is storing previews.
      if ((job.progress?.percent ?? 0) >= 90) setPhase('preparing');

      if (job.status === 'FAILED') {
        setError({
          message: job.error ?? 'Image generation failed.',
          ...(activeProvider ? { provider: activeProvider.label } : {}),
        });
        return;
      }

      if (job.status === 'SUCCEEDED') {
        applyResult(job.result ?? {});
        return;
      }
    }

    setError({
      message:
        'This is taking longer than expected. It may still finish — reload the page in a moment to see the result.',
    });
  }

  function applyResult(result: {
    assets?: GraphicAsset[];
    substitutedFrom?: string;
    aspectRatio?: string;
    warning?: string;
  }) {
    const produced = result.assets ?? [];
    setAssets((prev) => [...produced, ...prev]);
    setSelected(produced[0]?.id ?? null);

    if (result.substitutedFrom && result.aspectRatio) {
      toast(
        `${FORMAT_LABELS[result.substitutedFrom as AspectRatioKey]} isn't available on this model — generated as ${
          FORMAT_LABELS[result.aspectRatio as AspectRatioKey]
        } instead.`,
        { duration: 7000 },
      );
    }
    if (result.warning) toast(result.warning, { duration: 7000 });

    setUsage((prev) =>
      prev
        ? {
            ...prev,
            used: prev.used + produced.length,
            remaining: Math.max(0, prev.remaining - produced.length),
          }
        : prev,
    );
  }

  /**
   * Add a graphic the user already has.
   *
   * Deliberately shares everything after the request with generation: the
   * response is the same AssetView, so it lands in the same gallery, is
   * selected the same way, and attaches through the same endpoint. Nothing
   * downstream knows or cares that no model was involved.
   */
  async function addSuppliedImage(
    kind: 'file' | 'url',
    body: BodyInit,
    headers?: HeadersInit,
  ) {
    if (uploading) return;
    setUploading(kind);
    setError(null);
    try {
      const res = await fetch(
        `/api/content/graphics/upload?draftId=${encodeURIComponent(draftId)}`,
        { method: 'POST', body, ...(headers ? { headers } : {}) },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'That image could not be added.');
        return;
      }
      const data = (await res.json()) as { asset: GraphicAsset };
      setAssets((prev) => [data.asset, ...prev]);
      setSelected(data.asset.id);
      setUrlOpen(false);
      setImageUrl('');
      toast.success('Image added. Select “Attach to post” to use it.');
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setUploading(null);
    }
  }

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    // No content-type header: the browser must set the multipart boundary.
    await addSuppliedImage('file', form);
  }

  async function importFromUrl() {
    await addSuppliedImage(
      'url',
      JSON.stringify({ url: imageUrl.trim() }),
      { 'Content-Type': 'application/json' },
    );
  }

  async function attach(assetId: string) {
    const res = await fetch(`/api/content/graphics/${assetId}/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, replace: true }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? 'Could not attach that graphic.');
      return;
    }
    // Replacing means exactly one attachment, so the set is rebuilt rather
    // than added to — otherwise the previous image keeps its checkmark.
    setAttached(new Set([assetId]));
    setSelected(assetId);
    toast.success('Graphic attached to this post.');
    router.refresh();
  }

  async function remove(assetId: string) {
    const res = await fetch(`/api/content/graphics/${assetId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? 'Could not delete that graphic.');
      return;
    }
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
    setHistory((prev) => prev?.filter((a) => a.id !== assetId) ?? prev);
    setAttached((prev) => {
      const next = new Set(prev);
      next.delete(assetId);
      return next;
    });
    if (selected === assetId) setSelected(null);
    toast.success('Graphic deleted.');
    router.refresh();
  }

  /**
   * History is the whole workspace's graphics, not just this draft's, so it is
   * a separate fetch and a separate list. Loaded on first open and reused after
   * that — reopening the panel should not re-query.
   */
  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (!next || history !== null) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/content/drafts/${draftId}/graphics?scope=company`,
      );
      const data = res.ok
        ? ((await res.json()) as { assets: GraphicAsset[] })
        : { assets: [] };
      setHistory(data.assets);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  const busy = phase !== 'idle';
  const selectedAsset =
    assets.find((a) => a.id === selected) ??
    history?.find((a) => a.id === selected) ??
    null;

  const selectCls =
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  if (!open) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <ImageIcon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Graphic generation</p>
              <p className="text-sm text-muted-foreground">
                Aura reads this post and creates a matching graphic for{' '}
                {platformLabel}.
              </p>
            </div>
          </div>
          <Button onClick={openStudio} disabled={!canEdit}>
            <Wand2 className="h-4 w-4" /> Generate graphic
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Graphic generation
            </h2>
            <Badge variant="outline">{platformLabel}</Badge>
          </div>
          <div className="flex items-center gap-3">
            {usage && (
              <p className="text-xs text-muted-foreground">
                {usage.remaining} of {usage.limit} graphics left this month ·{' '}
                {usage.plan}
              </p>
            )}
            <Button variant="ghost" size="sm" onClick={toggleHistory}>
              <History className="h-4 w-4" />
              {showHistory ? 'This post only' : 'All graphics'}
            </Button>
          </div>
        </header>

        {!anyConfigured && providers.length > 0 && (
          <NotConfigured providers={providers} />
        )}

        {/* ---- Prompt ---- */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="image-prompt">Image prompt</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={writePrompt}
              loading={phase === 'analyzing' || phase === 'prompting'}
              disabled={busy || !canEdit}
            >
              <Sparkles className="h-4 w-4" />
              {prompt ? 'Rewrite from content' : 'Write from content'}
            </Button>
          </div>
          <Textarea
            id="image-prompt"
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Press “Write from content” and Aura will describe a graphic for this post — then edit it however you like."
            disabled={!canEdit}
          />
          {subject && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Shows:</span> {subject}
              {promptSource === 'heuristic' && (
                <>
                  {' '}
                  · Written without AI (no model configured) — worth editing
                  before generating.
                </>
              )}
            </p>
          )}
        </div>

        {/* ---- Controls ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="image-model">Model</Label>
            <select
              id="image-model"
              className={selectCls}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={!canEdit}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.configured}>
                  {p.label}
                  {p.configured ? '' : ' — not configured'}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {activeProvider
                ? activeProvider.configured
                  ? activeProvider.description
                  : `Not configured. Add ${activeProvider.credentialEnv} in Settings to enable it.`
                : 'Loading models…'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="image-format">Format</Label>
            <select
              id="image-format"
              className={selectCls}
              value={format}
              onChange={(e) => setFormat(e.target.value as FormatChoice)}
              disabled={!canEdit}
            >
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {FORMAT_LABELS[r]} ({r})
                </option>
              ))}
              <option value={CUSTOM_FORMAT}>Custom…</option>
            </select>

            {format === CUSTOM_FORMAT ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    aria-label="Custom width"
                    min={256}
                    max={4096}
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs"
                  />
                  <span className="text-sm text-muted-foreground">×</span>
                  <input
                    type="number"
                    aria-label="Custom height"
                    min={256}
                    max={4096}
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Number(e.target.value))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Image models only draw their own fixed sizes, so this is
                  matched to the closest shape they support — we&apos;ll tell you
                  which one was used.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {FORMAT_HINTS[format]}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="image-style">Style</Label>
            <select
              id="image-style"
              className={selectCls}
              value={style}
              onChange={(e) => setStyle(e.target.value as ImageStyleKey)}
              disabled={!canEdit}
            >
              {IMAGE_STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Variations</Label>
            <div className="flex gap-2">
              {[1, 2, 4].map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={variations === n ? 'default' : 'outline'}
                  onClick={() => setVariations(n)}
                  disabled={!canEdit || n > maxVariations}
                  title={
                    n > maxVariations
                      ? `Your plan and model allow up to ${maxVariations} at a time.`
                      : undefined
                  }
                >
                  {n}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Each variation is a separate paid generation.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={generate}
            loading={phase === 'generating' || phase === 'preparing'}
            disabled={busy || !canEdit || !anyConfigured || prompt.trim().length < 20}
          >
            <Sparkles className="h-4 w-4" />
            Generate {variations > 1 ? `${variations} images` : 'image'}
          </Button>

          {/* Already have a graphic? Adding it uses the same pipeline as a
              generated one, so it behaves identically from here on. */}
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            loading={uploading === 'file'}
            disabled={busy || !canEdit || uploading !== null}
          >
            <Upload className="h-4 w-4" /> Upload image
          </Button>
          <Button
            variant="ghost"
            onClick={() => setUrlOpen((v) => !v)}
            disabled={busy || !canEdit || uploading !== null}
          >
            <LinkIcon className="h-4 w-4" /> From URL
          </Button>

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset first: picking the same file twice must still fire.
              e.target.value = '';
              if (file) void uploadFile(file);
            }}
          />
        </div>

        {urlOpen && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
            <div className="min-w-[240px] flex-1 space-y-1.5">
              <Label htmlFor="image-url">Image URL</Label>
              <input
                id="image-url"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/graphic.png"
                className={selectCls}
              />
            </div>
            <Button
              onClick={importFromUrl}
              loading={uploading === 'url'}
              disabled={!canEdit || imageUrl.trim().length === 0}
            >
              Add image
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              The image is downloaded and stored with your post — it won&apos;t
              break if the original link goes away.
            </p>
          </div>
        )}

        {busy && <ProgressSteps phase={phase} />}

        {error && (
          <GenerationError
            error={error}
            providers={providers.filter((p) => p.configured && p.id !== provider)}
            onRetry={generate}
            onSwitch={(id) => {
              setProvider(id);
              setError(null);
            }}
            onDismiss={() => setError(null)}
          />
        )}

        {/* ---- Results ---- */}
        {(assets.length > 0 || showHistory) && (
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium text-foreground">
              {showHistory ? 'Graphic history' : 'Generated graphics'}
            </h3>

            {showHistory ? (
              historyLoading ? (
                <p className="text-sm text-muted-foreground">Loading history…</p>
              ) : (
                groupByDay(history ?? []).map((group) => (
                  <div key={group.label} className="space-y-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
                    <Gallery
                      assets={group.items}
                      attached={attached}
                      selected={selected}
                      canEdit={canEdit}
                      onSelect={setSelected}
                      onAttach={attach}
                      onDelete={remove}
                    />
                  </div>
                ))
              )
            ) : (
              <Gallery
                assets={assets}
                attached={attached}
                selected={selected}
                canEdit={canEdit}
                onSelect={setSelected}
                onAttach={attach}
                onDelete={remove}
              />
            )}
          </section>
        )}

        {selectedAsset && (
          <SelectedGraphic
            asset={selectedAsset}
            isAttached={attached.has(selectedAsset.id)}
            canEdit={canEdit}
            onAttach={() => attach(selectedAsset.id)}
            onRegenerate={generate}
            regenerating={busy}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The staged progress readout shown while a generation runs. */
function ProgressSteps({ phase }: { phase: Phase }) {
  const activeIndex = PHASE_STEPS.findIndex((s) => s.key === phase);
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="mb-2 text-sm font-medium text-foreground">
        Generating your graphic…
      </p>
      <ol className="space-y-1">
        {PHASE_STEPS.map((step, index) => {
          const done = activeIndex > index;
          const active = activeIndex === index;
          return (
            <li
              key={step.key}
              className={
                active
                  ? 'text-sm font-medium text-foreground'
                  : done
                    ? 'text-sm text-muted-foreground line-through'
                    : 'text-sm text-muted-foreground/60'
              }
            >
              {done ? '✓ ' : active ? '→ ' : '· '}
              {step.label}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">
        This usually takes 20-60 seconds. Your post is saved — leaving this page
        won&apos;t lose it.
      </p>
    </div>
  );
}

/**
 * Generation failure.
 *
 * Always offers a way forward — retry, or switch to another configured model —
 * because a provider outage is a normal Tuesday and a dead end here means the
 * user's approved content is stuck.
 */
function GenerationError({
  error,
  providers,
  onRetry,
  onSwitch,
  onDismiss,
}: {
  error: { message: string; provider?: string };
  providers: ProviderStatus[];
  onRetry: () => void;
  onSwitch: (id: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="flex-1 space-y-2">
          <div>
            <p className="text-sm font-medium text-foreground">
              Image generation failed
            </p>
            {error.provider && (
              <p className="text-xs text-muted-foreground">
                Provider: {error.provider}
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="h-4 w-4" /> Retry
            </Button>
            {providers.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="outline"
                onClick={() => onSwitch(p.id)}
              >
                Try {p.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Your post content is untouched.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function NotConfigured({ providers }: { providers: ProviderStatus[] }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm">
      <p className="font-medium text-foreground">No image model is configured</p>
      <p className="mt-0.5 text-muted-foreground">
        Add one of these keys to this deployment to enable graphic generation:
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
        {providers.map((p) => (
          <li key={p.id}>
            <span className="font-medium text-foreground">{p.label}</span> —{' '}
            <code className="rounded bg-muted px-1">{p.credentialEnv}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gallery({
  assets,
  attached,
  selected,
  canEdit,
  onSelect,
  onAttach,
  onDelete,
}: {
  assets: GraphicAsset[];
  attached: Set<string>;
  selected: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAttach: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (assets.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {assets.map((asset) => (
        <figure key={asset.id} className="space-y-1.5">
          <button
            type="button"
            onClick={() => onSelect(asset.id)}
            aria-pressed={selected === asset.id}
            className={`relative block w-full overflow-hidden rounded-lg border transition-all ${
              selected === asset.id
                ? 'border-primary ring-2 ring-primary/30'
                : 'border-border hover:border-primary/50'
            } ${aspectClass(asset.aspectRatio)}`}
          >
            {/* A plain img, not next/image: these are private, session-gated
                bytes from our own API — the optimizer would need a public URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.url}
              alt={`Generated graphic, ${asset.aspectRatio}`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
            {attached.has(asset.id) && (
              <span className="absolute right-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground">
                <Check className="h-3 w-3" />
              </span>
            )}
          </button>
          <figcaption className="flex items-center justify-between gap-1">
            <span className="truncate text-[11px] text-muted-foreground">
              {asset.aspectRatio} · {formatFileSize(asset.fileSize)}
            </span>
            <span className="flex shrink-0 gap-0.5">
              <a
                href={asset.url}
                download
                title="Download"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() => onAttach(asset.id)}
                    title="Use this image"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(asset.id)}
                    title="Delete"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function SelectedGraphic({
  asset,
  isAttached,
  canEdit,
  onAttach,
  onRegenerate,
  regenerating,
}: {
  asset: GraphicAsset;
  isAttached: boolean;
  canEdit: boolean;
  onAttach: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium text-foreground">Selected graphic</h3>
      <div className="flex flex-wrap gap-4">
        <div
          className={`w-40 shrink-0 overflow-hidden rounded-lg border border-border ${aspectClass(
            asset.aspectRatio,
          )}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.url}
            alt="Selected graphic preview"
            className="h-full w-full object-cover"
          />
        </div>
        <div className="min-w-[200px] flex-1 space-y-2 text-sm">
          <p className="text-muted-foreground">
            {asset.width}×{asset.height} · {formatFileSize(asset.fileSize)} ·{' '}
            {asset.mimeType.replace('image/', '').toUpperCase()}
          </p>
          <p className="text-xs text-muted-foreground">
            {asset.provider} · {asset.model}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              onClick={onAttach}
              disabled={!canEdit || isAttached}
            >
              <Check className="h-4 w-4" />
              {isAttached ? 'Attached to post' : 'Attach to post'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onRegenerate}
              loading={regenerating}
              disabled={!canEdit}
            >
              <RotateCcw className="h-4 w-4" /> Regenerate
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={asset.url} download>
                <Download className="h-4 w-4" /> Download
              </a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
