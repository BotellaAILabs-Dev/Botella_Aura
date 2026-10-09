'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { JobState } from '@/components/dashboard/jobs/use-generation-job';

/**
 * The status line for a background generation.
 *
 * The complaint this answers is "reads as hung": a bare spinner tells the user
 * nothing, so a slow-but-working run is indistinguishable from a dead one.
 * Here they always see which step is executing, roughly how far along it is,
 * and — on failure — the provider's real message plus a retry that reuses the
 * brief they already typed.
 */
export function JobProgressBar({
  job,
  runningLabel,
  onRetry,
  expectedSeconds,
}: {
  job: JobState | null;
  runningLabel?: string;
  onRetry?: () => void;
  /**
   * How long a run of this kind normally takes. When given, the bar shows the
   * time so far against it, and says so plainly once a run goes past it — so
   * a slow run reads as slow, not frozen.
   */
  expectedSeconds?: number;
}) {
  const elapsed = useElapsedSeconds(
    job && (job.status === 'QUEUED' || job.status === 'RUNNING') ? job.createdAt : undefined,
  );
  if (!job) return null;

  if (job.status === 'FAILED') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">That run didn&apos;t finish.</p>
          <p className="mt-0.5 text-muted-foreground">
            {job.error ?? 'Something went wrong.'}
          </p>
          {onRetry && (
            <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
              <RotateCw className="h-4 w-4" /> Try again
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (job.status === 'SUCCEEDED') return null;

  const percent = Math.max(4, Math.min(99, job.progress.percent));

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="font-medium">{runningLabel ?? 'Generating…'}</span>
        <span className="ml-auto tabular-nums text-xs text-muted-foreground">
          {percent}%
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{job.progress.message}</p>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full bg-primary transition-all duration-500')}
          style={{ width: `${percent}%` }}
        />
      </div>
      {expectedSeconds !== undefined && elapsed !== null && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {formatSeconds(elapsed)} so far · usually about {formatSeconds(expectedSeconds)}
        </p>
      )}
      {expectedSeconds !== undefined && elapsed !== null && elapsed > expectedSeconds && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" role="status">
          Taking longer than usual — still working. If it can&apos;t finish, you&apos;ll see a
          Try again button here; your brief is kept.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        This keeps running if you leave the page — come back and it&apos;ll be here.
      </p>
    </div>
  );
}

/** Whole seconds since `iso`, ticking once a second; null without a start. */
function useElapsedSeconds(iso: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  if (!iso) return null;
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((now - start) / 1000));
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return sec ? `${m}m ${sec}s` : `${m}m`;
}
