'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { LocalTime } from '@/components/ui/local-time';
import { cn } from '@/lib/utils';
import type { ReviewKind } from '@/lib/review-item';
import type { VersionSummary } from '@/lib/versions';

/**
 * Every version of a piece (lib/versions.ts): the original AI version, each
 * edit and regeneration, who made it and when — and the approved one. Making
 * an older version current brings it back as a new version; nothing is lost.
 */

export interface VersionView extends VersionSummary {
  byName: string;
  text: string;
}

export function VersionsPanel({
  kind,
  id,
  updatedAt,
  canRestore,
  approvedNow,
  initial,
}: {
  kind: ReviewKind;
  id: string;
  /** Reload when the item changes. */
  updatedAt: string;
  canRestore: boolean;
  /** The item is approved now — restoring reopens it. */
  approvedNow: boolean;
  /** Rendered with the page, so the history is there on first paint. */
  initial?: VersionView[] | null;
}) {
  const router = useRouter();
  const [versions, setVersions] = useState<VersionView[] | null>(
    initial ?? null,
  );
  const loadedFor = useRef<string | null>(initial ? updatedAt : null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (loadedFor.current === updatedAt) return;
    loadedFor.current = updatedAt;
    let live = true;
    fetch(`/api/review/${kind}/${id}/versions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { versions: VersionView[] } | null) => {
        if (live && d) setVersions(d.versions);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [kind, id, updatedAt]);

  async function restore(n: number) {
    if (
      approvedNow &&
      !window.confirm(
        'This is approved. Making another version current reopens it for approval. Continue?',
      )
    )
      return;
    setBusy(n);
    try {
      const res = await fetch(`/api/review/${kind}/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: n }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        current?: number;
      };
      if (!res.ok) {
        toast.error(d.error ?? 'Could not restore that version.');
        return;
      }
      toast.success(
        `Version ${n} is current again (saved as version ${d.current}).`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!versions) return null;
  return (
    <Card data-testid="versions-panel">
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Versions</h2>
          <span className="text-xs text-muted-foreground">
            {versions.length} kept
          </span>
        </div>
        <ol className="space-y-2" aria-label="Versions">
          {versions.map((v) => (
            <li
              key={v.n}
              className={cn(
                'rounded-md border p-2',
                v.isCurrent && 'border-primary/50 bg-primary/5',
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">v{v.n}</span>
                <span className="text-xs text-muted-foreground">{v.label}</span>
                {v.isOriginal && <Badge variant="muted">Original</Badge>}
                {v.isCurrent && <Badge variant="default">Current</Badge>}
                {v.isApproved && <Badge variant="success">Approved</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {v.byName} · <LocalTime iso={v.at} />
                {v.basedOn ? ` · from v${v.basedOn}` : ''}
                {v.note && !v.basedOn ? ` · ${v.note}` : ''}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setOpen(open === v.n ? null : v.n)}
                  aria-expanded={open === v.n}
                >
                  {open === v.n ? 'Hide text' : 'Show text'}
                </button>
                {canRestore && !v.isCurrent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => restore(v.n)}
                    loading={busy === v.n}
                    disabled={busy !== null}
                  >
                    <RotateCcw className="h-3 w-3" /> Make this current
                  </Button>
                )}
              </div>
              {open === v.n && (
                <p className="mt-1.5 whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs text-foreground">
                  {v.text || '—'}
                </p>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
