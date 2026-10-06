'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
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
  activeVariation,
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
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const blocking = quality?.issues.filter((i) => i.severity === 'block') ?? [];
  const warnings = quality?.issues.filter((i) => i.severity === 'warn') ?? [];

  async function use(index: number) {
    setBusy(index);
    try {
      const res = await fetch(`/api/content/drafts/${draftId}/variation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not switch versions.');
        return;
      }
      toast.success('Switched version. Undo is available.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

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

      {variations.length > 1 && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <Layers className="h-4 w-4" /> {variations.length} versions
          </p>
          <ul className="space-y-2">
            {variations.map((v, i) => (
              <li
                key={i}
                className={
                  'rounded-md border p-3 ' +
                  (i === activeVariation
                    ? 'border-primary bg-primary/5'
                    : 'border-border')
                }
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {v.angle || `Version ${i + 1}`}
                  </span>
                  {i === activeVariation ? (
                    <Badge>In use</Badge>
                  ) : (
                    editable && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        loading={busy === i}
                        onClick={() => use(i)}
                      >
                        Use this version
                      </Button>
                    )
                  )}
                </div>
                <p className="line-clamp-3 text-foreground">{v.snippet}</p>
                {!v.approvable && (
                  <p className="mt-1 text-xs text-destructive">
                    Has {v.issues} issue{v.issues === 1 ? '' : 's'} to fix
                    before approval.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
