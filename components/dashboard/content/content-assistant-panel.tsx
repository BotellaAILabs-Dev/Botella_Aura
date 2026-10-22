'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  Layers,
  ShieldCheck,
  Wrench,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import type { QualityIssue } from '@/lib/content-quality';

export interface AssistantVariation {
  angle: string;
  snippet: string;
  approvable: boolean;
  issues: number;
  /** The whole version, to read before choosing it. */
  text?: string;
  /** What kind of variation it is (absent on versions written at generation). */
  kind?: string;
  /** The network a channel variation is written for. */
  platformLabel?: string | null;
  /** The facts guard: null when not checked (versions written at generation). */
  factsKept?: boolean | null;
  introduced?: string[];
  /** What must be fixed before approval, in words. */
  blockers?: string[];
}

/** What can be asked for on this draft (lib/content-variations.ts). */
export interface VariationOption {
  kind: string;
  label: string;
  available: boolean;
  reason: string | null;
  platforms?: { key: string; label: string }[];
  tones?: readonly string[];
}

/**
 * What the writing assistant knows about this draft: where it was written
 * for, the quality and compliance check (and anything that must be fixed
 * before approval), the automatic fixes it made, and the other versions it
 * wrote — with a one-click switch.
 */
export function ContentAssistantPanel({
  draftId,
  editable,
  writtenFor,
  tone,
  quality,
  variations,
  options = [],
}: {
  draftId: string;
  editable: boolean;
  writtenFor: string | null;
  tone: string | null;
  quality: {
    issues: QualityIssue[];
    fixes: string[];
    alcohol: boolean;
    approvable: boolean;
  } | null;
  variations: AssistantVariation[];
  activeVariation: number;
  /** Variations that can be made here; empty when the draft cannot be varied. */
  options?: VariationOption[];
}) {
  const router = useRouter();
  const [making, setMaking] = useState<string | null>(null);
  const [pickTone, setPickTone] = useState('');
  const [channel, setChannel] = useState('');

  /** Ask for a variation; it is added next to the original, not over it. */
  async function vary(kind: string, extra: Record<string, string> = {}) {
    setMaking(kind);
    try {
      if (kind === 'image') {
        await anotherImage();
        return;
      }
      const res = await fetch(`/api/content/drafts/${draftId}/variations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...extra }),
      });
      const b = (await res.json().catch(() => ({}))) as {
        error?: string;
        label?: string;
        factsKept?: boolean;
      };
      if (!res.ok) {
        toast.error(b.error ?? 'Could not make that variation.');
        return;
      }
      toast.success(
        b.factsKept === false
          ? `Added “${b.label}” — it changes a fact, so review it before using it.`
          : `Added “${b.label}” — read it below and use it if you prefer it.`,
      );
      router.refresh();
    } finally {
      setMaking(null);
    }
  }

  /** Another image from the same brief, through the graphics workflow. */
  async function anotherImage() {
    const req = await fetch(`/api/content/drafts/${draftId}/variations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image' }),
    });
    const r = (await req.json().catch(() => ({}))) as {
      error?: string;
      image?: { prompt: string; negativePrompt?: string; style: string; aspectRatio?: string };
    };
    if (!req.ok || !r.image) {
      toast.error(r.error ?? 'Could not prepare another image.');
      return;
    }
    const res = await fetch(`/api/content/drafts/${draftId}/graphics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r.image, variations: 1 }),
    });
    const q = (await res.json().catch(() => ({}))) as { error?: string; jobId?: string; reused?: boolean };
    if (!res.ok || !q.jobId) {
      toast.error(q.error ?? 'Could not start another image. Your post is unaffected.');
      return;
    }
    if (!q.reused) void fetch(`/api/jobs/${q.jobId}/run`, { method: 'POST' }).catch(() => undefined);
    toast('Making another image — it appears under your graphics when ready.');
    for (let i = 0; i < 80; i++) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const job = (await fetch(`/api/jobs/${q.jobId}`, { cache: 'no-store' })
        .then((x) => x.json())
        .catch(() => null)) as { status?: string; error?: string | null } | null;
      if (job?.status === 'SUCCEEDED') {
        window.dispatchEvent(new Event('aura:graphics-refresh'));
        toast.success('Another image is ready — review it with your graphics.');
        return;
      }
      if (job?.status === 'FAILED') {
        toast.error(`${job.error ?? 'The image could not be made.'} Your post is unaffected — try again or another model.`);
        return;
      }
    }
    toast('Still working on the image — it will appear when it lands.');
  }
  const blocking = quality?.issues.filter((i) => i.severity === 'block') ?? [];
  const warnings = quality?.issues.filter((i) => i.severity === 'warn') ?? [];

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {writtenFor && (
          <Badge variant="outline">Written for {writtenFor}</Badge>
        )}
        {tone && <Badge variant="outline">Tone: {tone}</Badge>}
        {quality?.alcohol && (
          <Badge variant="outline" className="gap-1">
            <ShieldCheck className="h-3 w-3" /> Alcohol marketing rules applied
          </Badge>
        )}
      </div>

      {quality ? (
        <div className="space-y-2">
          {quality.approvable && !warnings.length ? (
            <p className="flex items-center gap-2 text-success-foreground [color:hsl(var(--success))]">
              <CheckCircle2 className="h-4 w-4" /> Passed every quality and
              compliance check.
            </p>
          ) : null}
          {blocking.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-1 flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" /> Fix before approving
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-foreground">
                {blocking.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Use “Improve” to have the writer fix these, or edit the copy
                yourself.
              </p>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-1 flex items-center gap-2 font-medium text-foreground">
                <Info className="h-4 w-4" /> Worth a look
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {warnings.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}
          {quality.fixes.length > 0 && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Fixed automatically: {quality.fixes.join(' ')}
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground">
          Written before quality checks existed. Any rewrite or edit runs them.
        </p>
      )}

      {editable && options.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <Copy className="h-4 w-4" /> Make a variation
          </p>
          <p className="text-xs text-muted-foreground">
            Added next to this version — nothing is replaced. The goal, audience,
            facts, evidence and brand stay the same.
          </p>
          <div className="flex flex-wrap gap-2">
            {options
              .filter((o) => o.available && !['tone', 'channel'].includes(o.kind))
              .map((o) => (
                <Button
                  key={o.kind}
                  size="sm"
                  variant="outline"
                  disabled={making !== null}
                  loading={making === o.kind}
                  onClick={() => void vary(o.kind)}
                >
                  {o.label}
                </Button>
              ))}
          </div>
          {options
            .filter((o) => o.available && (o.kind === 'tone' || o.kind === 'channel'))
            .map((o) => (
              <div key={o.kind} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={o.label}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={o.kind === 'tone' ? pickTone : channel}
                  onChange={(e) => (o.kind === 'tone' ? setPickTone(e.target.value) : setChannel(e.target.value))}
                >
                  <option value="">{o.kind === 'tone' ? 'Pick a tone…' : 'Pick a channel…'}</option>
                  {o.kind === 'tone'
                    ? (o.tones ?? []).map((t) => (
                        <option key={t} value={t}>
                          {t[0]!.toUpperCase() + t.slice(1)}
                        </option>
                      ))
                    : (o.platforms ?? []).map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={making !== null || !(o.kind === 'tone' ? pickTone : channel)}
                  loading={making === o.kind}
                  onClick={() =>
                    void vary(o.kind, o.kind === 'tone' ? { tone: pickTone } : { platform: channel })
                  }
                >
                  {o.label}
                </Button>
              </div>
            ))}
          {options.some((o) => !o.available) && (
            <p className="text-xs text-muted-foreground">
              {options
                .filter((o) => !o.available)
                .map((o) => `${o.label}: ${o.reason}`)
                .join(' ')}
            </p>
          )}
        </div>
      )}

      {variations.length > 1 && (
        <a
          href="#recommendations"
          className="flex items-center gap-2 rounded-md border border-border p-3 font-medium text-foreground hover:bg-muted"
        >
          <Layers className="h-4 w-4" aria-hidden /> {variations.length} versions — compare, edit and choose them under
          Recommendations
        </a>
      )}
    </div>
  );
}
