'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Clock, ExternalLink, Film, Image as ImageIcon, RotateCw, Send, TriangleAlert } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

type Platform = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN';

interface Preview {
  platform: Platform;
  label: string;
  text: string;
  images: number;
  videos: number;
  ready: boolean;
  blockers: string[];
  publication: {
    status: 'PUBLISHING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'MANUAL';
    url: string | null;
    message: string | null;
    attempts: number;
  } | null;
}

interface State {
  status: string;
  canPublish: boolean;
  canApprove: boolean;
  preview: Preview[];
}

type Result =
  | { platform: Platform; status: 'published'; url: string | null }
  | { platform: Platform; status: 'processing' | 'manual' | 'failed' | 'skipped'; message: string };

/**
 * "Approve & Publish to Selected Platforms" — one action for Facebook,
 * Instagram and LinkedIn (server/content/multi-publish.service.ts). Shows
 * exactly what each network receives, which can go and why not, then the
 * result per network. Failures are retried only by pressing Retry.
 */
export function MultiPublish({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [needsAck, setNeedsAck] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [expanded, setExpanded] = useState<Platform | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/content/drafts/${draftId}/publications`);
    if (r.ok) setState((await r.json()) as State);
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A Reel Instagram is still processing: check every 20 s while this is open.
  const processing = Boolean(state?.preview.some((p) => p.publication?.status === 'PROCESSING'));
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(async () => {
      await fetch(`/api/content/drafts/${draftId}/publications`, { method: 'PATCH' }).catch(() => undefined);
      await load();
      router.refresh();
    }, 20_000);
    return () => clearInterval(timer);
  }, [processing, draftId, load, router]);

  if (!state || state.status === 'REJECTED') return null;
  const approved = state.status === 'APPROVED' || state.status === 'PUBLISHED';
  const mayAct = state.canPublish && (approved || state.canApprove);

  function toggle(p: Platform) {
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  }

  async function publish(platforms: Platform[]) {
    const names = platforms.map((p) => state!.preview.find((x) => x.platform === p)!.label).join(', ');
    const verb = approved ? 'Publish' : 'Approve and publish';
    if (!window.confirm(`${verb} this post to ${names} now? Each network gets exactly the text shown.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/content/drafts/${draftId}/publications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms, ...(needsAck && ack ? { acknowledged: true } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { results?: Result[]; error?: string; code?: string };
      if (res.status === 409 && (body.code === 'facts_need_review' || body.code === 'review_needs_human')) {
        setNeedsAck(body.error ?? 'Aura flagged something for a person to check.');
        return;
      }
      if (!res.ok || !body.results) {
        toast.error(body.error ?? 'Could not publish.');
        return;
      }
      setResults(body.results);
      setNeedsAck(null);
      setAck(false);
      setSelected([]);
      const ok = body.results.filter((r) => r.status === 'published').length;
      if (ok) toast.success(`Published to ${ok} network${ok === 1 ? '' : 's'}.`);
      if (body.results.some((r) => r.status === 'processing')) {
        toast('Instagram is processing the video — it goes live when that finishes.', { duration: 8000 });
      }
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4 text-primary" /> Publish to several networks
        </CardTitle>
        <CardDescription>
          Choose where this goes. Each network gets the text below, through its official API, one after another — not at
          the same instant. Nothing is posted twice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.preview.map((p) => {
          const pub = p.publication;
          return (
            <div key={p.platform} className="rounded-md border border-border p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={selected.includes(p.platform)}
                  disabled={!p.ready || !mayAct || busy}
                  onChange={() => toggle(p.platform)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {p.label}
                    {pub?.status === 'PUBLISHED' && <Badge variant="success">Published</Badge>}
                    {pub?.status === 'FAILED' && <Badge variant="destructive">Failed</Badge>}
                    {pub?.status === 'MANUAL' && <Badge variant="warning">Post by hand</Badge>}
                    {pub?.status === 'PUBLISHING' && <Badge variant="secondary">Publishing…</Badge>}
                    {pub?.status === 'PROCESSING' && (
                      <Badge variant="secondary">
                        <Clock className="h-3 w-3" /> Processing
                      </Badge>
                    )}
                    {p.images - p.videos > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <ImageIcon className="h-3 w-3" /> {p.images - p.videos}
                      </span>
                    )}
                    {p.videos > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <Film className="h-3 w-3" /> {p.videos}
                      </span>
                    )}
                    {p.platform === 'INSTAGRAM' && p.images > 1 && (
                      <span className="text-xs font-normal text-muted-foreground">carousel</span>
                    )}
                    {p.platform === 'INSTAGRAM' && p.images === 1 && p.videos === 1 && (
                      <span className="text-xs font-normal text-muted-foreground">Reel</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="mt-1 block w-full whitespace-pre-line text-left text-xs text-muted-foreground"
                    onClick={() => setExpanded(expanded === p.platform ? null : p.platform)}
                  >
                    {expanded === p.platform ? p.text : `${p.text.slice(0, 180)}${p.text.length > 180 ? '… (show all)' : ''}`}
                  </button>
                  {pub?.url && (
                    <a href={pub.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      View the post <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {!p.ready && p.blockers.length > 0 && pub?.status !== 'PUBLISHED' && (
                    <span className="mt-1 flex items-start gap-1.5 text-xs text-foreground">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      {p.blockers.join(' ')}
                    </span>
                  )}
                  {(pub?.status === 'FAILED' || pub?.status === 'MANUAL') && pub.message && (
                    <span className="mt-1 block text-xs text-muted-foreground">Last attempt: {pub.message}</span>
                  )}
                  {(pub?.status === 'FAILED' || pub?.status === 'MANUAL') && p.ready && mayAct && (
                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => publish([p.platform])}>
                      <RotateCw className="h-3.5 w-3.5" /> Retry {p.label}
                    </Button>
                  )}
                </span>
              </label>
            </div>
          );
        })}

        {needsAck && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
            <p>Before approving: {needsAck}</p>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I’ve checked these myself.
            </label>
          </div>
        )}

        {results && (
          <ul className="space-y-1 text-xs">
            {results.map((r) => (
              <li key={r.platform} className="flex items-start gap-1.5">
                {r.status === 'published' ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />
                ) : r.status === 'processing' ? (
                  <Clock className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-amber-600" />
                )}
                <span>
                  <span className="font-medium">{state.preview.find((p) => p.platform === r.platform)?.label}:</span>{' '}
                  {r.status === 'published' ? 'published.' : r.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        {mayAct ? (
          <Button
            className="w-full"
            loading={busy}
            disabled={selected.length === 0 || (Boolean(needsAck) && !ack)}
            onClick={() => publish(selected)}
          >
            <Send className="h-4 w-4" /> {approved ? 'Publish to selected platforms' : 'Approve & Publish to Selected Platforms'}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Only owners and admins can approve and publish.</p>
        )}
      </CardContent>
    </Card>
  );
}
