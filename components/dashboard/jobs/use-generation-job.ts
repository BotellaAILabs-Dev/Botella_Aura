'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drives a background generation from the browser: queue it, kick the runner
 * without waiting on it, then poll for progress.
 *
 * The kick is deliberately un-awaited. That request is the one that takes
 * minutes; awaiting it would reintroduce exactly the timeout this system
 * exists to remove. Its response is ignored — every outcome, success or
 * failure, reaches us through the polled job row instead, which is also what
 * makes the run survive a closed tab.
 */
export type JobKind = 'TREND_DIGEST' | 'MARKETING_PLAN' | 'INTELLIGENCE';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface JobProgress {
  step: string;
  message: string;
  percent: number;
}

export interface JobState {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  result?: Record<string, unknown>;
  error?: string | null;
  /** When the run was queued (ISO) — what elapsed time is measured from. */
  createdAt?: string;
}

const POLL_MS = 1500;
/** Stop polling rather than hammer the API forever if a job never resolves. */
const MAX_POLLS = 400; // ~10 minutes

export function useGenerationJob(kind: JobKind, options?: {
  onDone?: (job: JobState) => void;
  /**
   * Stop waiting after this long and show a failure the user can retry.
   *
   * Must not be shorter than the server's fuse for this kind (stuckAfterMs),
   * or "Try again" would reattach to the run being given up on.
   */
  giveUpAfterMs?: number;
}) {
  const [job, setJob] = useState<JobState | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polls = useRef(0);
  /** When the current run was queued, in this browser's clock. */
  const startedAt = useRef<number | null>(null);
  /**
   * Same orphan-loop guard as the app-wide indicator: an in-flight poll must
   * not arm a fresh timer after the component has gone, or every remount
   * leaves another loop running.
   */
  const alive = useRef(true);
  const onDone = useRef(options?.onDone);
  onDone.current = options?.onDone;
  const giveUpAfterMs = options?.giveUpAfterMs;
  /** Set synchronously, so a double-click cannot get two requests out. */
  const inFlight = useRef(false);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);

  const poll = useCallback(
    async (id: string) => {
      if (!alive.current) return;
      if (polls.current++ > MAX_POLLS) {
        setJob((j) =>
          j
            ? {
                ...j,
                status: 'FAILED',
                error:
                  'This is taking much longer than expected. Reload the page — if it was still running, you will see the result.',
              }
            : j,
        );
        return;
      }
      if (giveUpAfterMs && startedAt.current && Date.now() - startedAt.current > giveUpAfterMs) {
        stop();
        setJob((j) =>
          j
            ? {
                ...j,
                status: 'FAILED',
                error: `This did not finish in the expected time (it normally takes under ${Math.round(giveUpAfterMs / 60_000)} minutes). Your brief is saved — try again.`,
              }
            : j,
        );
        return;
      }
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('lost the job');
        const next = (await res.json()) as JobState;
        if (!alive.current) return;
        setJob(next);

        if (next.status === 'SUCCEEDED' || next.status === 'FAILED') {
          stop();
          onDone.current?.(next);
          return;
        }
      } catch {
        // A dropped poll is not a failed job — keep trying until MAX_POLLS.
      }
      if (alive.current) {
        timer.current = setTimeout(() => void poll(id), POLL_MS);
      }
    },
    [stop, giveUpAfterMs],
  );

  /** Attach to a run already in flight (e.g. after a page reload). */
  const attach = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs?kind=${kind}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { job: JobState | null };
      if (!body.job) return;
      if (body.job.status === 'QUEUED' || body.job.status === 'RUNNING') {
        setJob(body.job);
        polls.current = 0;
        const queued = body.job.createdAt ? Date.parse(body.job.createdAt) : NaN;
        startedAt.current = Number.isFinite(queued) ? Math.min(queued, Date.now()) : Date.now();
        void poll(body.job.id);
      }
    } catch {
      // Reattaching is best-effort.
    }
  }, [kind, poll]);

  const start = useCallback(
    async (inputs?: Record<string, unknown>): Promise<string | null> => {
      // A second click while the first is still being sent is the same request.
      if (inFlight.current) return null;
      inFlight.current = true;
      setStarting(true);
      stop();
      polls.current = 0;
      startedAt.current = Date.now();
      try {
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, inputs }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          id?: string;
          status?: JobStatus;
          progress?: JobProgress;
          reused?: boolean;
          error?: string;
          createdAt?: string;
        };
        if (!res.ok || !body.id) {
          setJob({
            id: 'none',
            status: 'FAILED',
            progress: { step: 'failed', message: '', percent: 100 },
            error: body.error ?? 'Could not start this run.',
          });
          return null;
        }

        if (body.reused && body.createdAt) {
          // Attached to a run already going: its clock, not this click's.
          const queued = Date.parse(body.createdAt);
          if (Number.isFinite(queued)) startedAt.current = Math.min(queued, Date.now());
        }
        setJob({
          id: body.id,
          status: body.status ?? 'QUEUED',
          ...(body.createdAt ? { createdAt: body.createdAt } : {}),
          progress: body.progress ?? {
            step: 'queued',
            message: 'Queued…',
            percent: 0,
          },
        });

        // Kick the runner. Not awaited — see the note at the top of this file.
        if (!body.reused) {
          void fetch(`/api/jobs/${body.id}/run`, {
            method: 'POST',
            keepalive: true,
          }).catch(() => {
            // The cron reaper picks up anything this kick failed to start.
          });
        }

        void poll(body.id);
        return body.id;
      } finally {
        inFlight.current = false;
        setStarting(false);
      }
    },
    [kind, poll, stop],
  );

  const running =
    starting || job?.status === 'QUEUED' || job?.status === 'RUNNING';

  return { job, start, attach, running, starting };
}
