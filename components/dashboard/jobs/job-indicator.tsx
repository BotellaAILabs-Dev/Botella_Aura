'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * App-wide indicator for background generations.
 *
 * Without this, "moved to a background job" is only half true: the user still
 * has to sit on the page that started it to learn what happened. This polls
 * workspace-wide, so a trend digest kicked off before navigating away still
 * announces itself — which is the difference between a job that runs in the
 * background and one the user merely cannot watch.
 *
 * Polls quickly only while something is in flight, then backs off to idle.
 */
const KIND_LABEL: Record<string, string> = {
  TREND_DIGEST: 'Trend digest',
  MARKETING_PLAN: 'Monthly calendar',
  INTELLIGENCE: 'Marketing analysis',
};

const KIND_HREF: Record<string, string> = {
  TREND_DIGEST: '/dashboard/trends',
  MARKETING_PLAN: '/dashboard/planner',
  INTELLIGENCE: '/dashboard/intelligence',
};

const ACTIVE_POLL_MS = 2500;
const IDLE_POLL_MS = 20_000;

interface ActiveJob {
  id: string;
  kind: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  progress: { step: string; message: string; percent: number };
  error?: string | null;
  finishedAt: string | null;
}

function clampPercent(percent: number): number {
  return Math.max(4, Math.min(99, percent));
}

export function JobIndicator() {
  const router = useRouter();
  const [running, setRunning] = useState<ActiveJob[]>([]);
  const [finished, setFinished] = useState<ActiveJob | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Completions already announced, so each is reported exactly once. */
  const announced = useRef<Set<string>>(new Set());
  /** Jobs this session actually saw running. */
  const wasRunning = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    let delay = IDLE_POLL_MS;
    try {
      const res = await fetch('/api/jobs/active', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { jobs: ActiveJob[] };
        const active = body.jobs.filter(
          (j) => j.status === 'QUEUED' || j.status === 'RUNNING',
        );
        setRunning(active);
        if (active.length > 0) delay = ACTIVE_POLL_MS;

        for (const job of active) wasRunning.current.add(job.id);

        // Announce only jobs this session watched start — otherwise a fresh
        // page load would replay every recent completion as though it were new.
        const justDone = body.jobs.find(
          (j) =>
            (j.status === 'SUCCEEDED' || j.status === 'FAILED') &&
            wasRunning.current.has(j.id) &&
            !announced.current.has(j.id),
        );
        if (justDone) {
          announced.current.add(justDone.id);
          setFinished(justDone);
          // Pull the finished result into whatever page happens to be open.
          router.refresh();
        }
      }
    } catch {
      // A dropped poll is not worth surfacing; the next tick retries.
    }
    timer.current = setTimeout(() => void poll(), delay);
  }, [router]);

  useEffect(() => {
    void poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  if (running.length === 0 && !finished) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {running.map((job) => (
        <div
          key={job.id}
          className="pointer-events-auto rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <span className="font-medium text-foreground">
              {KIND_LABEL[job.kind] ?? 'Generating'}
            </span>
            <span className="ml-auto tabular-nums text-xs text-muted-foreground">
              {clampPercent(job.progress.percent)}%
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {job.progress.message}
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${clampPercent(job.progress.percent)}%` }}
            />
          </div>
        </div>
      ))}

      {finished && (
        <div
          className={cn(
            'pointer-events-auto rounded-lg border bg-card p-3 shadow-lg',
            finished.status === 'SUCCEEDED'
              ? 'border-primary/40'
              : 'border-destructive/40',
          )}
        >
          <div className="flex items-start gap-2 text-sm">
            {finished.status === 'SUCCEEDED' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">
                {KIND_LABEL[finished.kind] ?? 'Generation'}{' '}
                {finished.status === 'SUCCEEDED' ? 'ready' : 'failed'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {finished.status === 'SUCCEEDED'
                  ? 'Finished while you were elsewhere.'
                  : (finished.error ?? 'Something went wrong.')}
              </p>
              {finished.status === 'SUCCEEDED' && KIND_HREF[finished.kind] && (
                <button
                  type="button"
                  onClick={() => {
                    router.push(KIND_HREF[finished.kind]!);
                    setFinished(null);
                  }}
                  className="mt-1.5 text-xs font-medium text-primary hover:underline"
                >
                  View it
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFinished(null)}
              aria-label="Dismiss"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
