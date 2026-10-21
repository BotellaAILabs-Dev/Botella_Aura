/**
 * Execution state machine — one lifecycle for every provider action.
 *
 *   APPROVED → READY_FOR_EXECUTION → SCHEDULED ─┐
 *                                  └→ QUEUED ←──┘ (due, or "publish now")
 *   QUEUED → EXECUTING → COMPLETED
 *   EXECUTING → FAILED → QUEUED (retry) | ACTION_REQUIRED
 *   SCHEDULED / READY / QUEUED → CANCELLED
 *
 * Rules the server enforces with this table (server/execution/engine.service.ts):
 *   - only the transitions below are allowed; anything else is refused
 *   - COMPLETED is final: a completed execution can never run again
 *   - every change is recorded as an ExecutionEvent
 *   - FAILED and ACTION_REQUIRED keep the error that caused them
 *
 * Pure and client-safe.
 */

export const EXECUTION_STATES = [
  'APPROVED',
  'READY_FOR_EXECUTION',
  'SCHEDULED',
  'QUEUED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'ACTION_REQUIRED',
  'CANCELLED',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  APPROVED: ['READY_FOR_EXECUTION', 'ACTION_REQUIRED', 'CANCELLED'],
  READY_FOR_EXECUTION: ['SCHEDULED', 'QUEUED', 'ACTION_REQUIRED', 'CANCELLED', 'APPROVED'],
  // SCHEDULED → SCHEDULED is a reschedule (the time changed).
  SCHEDULED: ['SCHEDULED', 'QUEUED', 'READY_FOR_EXECUTION', 'ACTION_REQUIRED', 'CANCELLED', 'APPROVED'],
  QUEUED: ['EXECUTING', 'SCHEDULED', 'ACTION_REQUIRED', 'CANCELLED', 'COMPLETED'],
  // EXECUTING → EXECUTING: the provider accepted it and is still processing.
  EXECUTING: ['EXECUTING', 'COMPLETED', 'FAILED', 'ACTION_REQUIRED'],
  COMPLETED: [],
  FAILED: ['QUEUED', 'ACTION_REQUIRED', 'CANCELLED', 'SCHEDULED'],
  ACTION_REQUIRED: ['READY_FOR_EXECUTION', 'QUEUED', 'SCHEDULED', 'CANCELLED', 'APPROVED'],
  // Cancelled work comes back only by being approved again.
  CANCELLED: ['APPROVED'],
};

export function canTransition(from: ExecutionState | null, to: ExecutionState): boolean {
  if (from === null) return to === 'APPROVED';
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly status = 409;
  readonly code = 'invalid_transition';
  constructor(
    readonly from: ExecutionState,
    readonly to: ExecutionState,
  ) {
    super(
      from === 'COMPLETED'
        ? 'This has already been published — it cannot run again.'
        : `An execution that is ${STATE_LABEL[from].toLowerCase()} cannot become ${STATE_LABEL[to].toLowerCase()}.`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * The path from one state to another through allowed transitions (shortest),
 * so "publish now" from APPROVED records APPROVED → READY → QUEUED → EXECUTING
 * rather than jumping. Null when unreachable.
 */
export function pathTo(from: ExecutionState, to: ExecutionState): ExecutionState[] | null {
  if (from === to) return [];
  const prev = new Map<ExecutionState, ExecutionState>();
  const queue: ExecutionState[] = [from];
  const seen = new Set<ExecutionState>([from]);
  while (queue.length) {
    const s = queue.shift()!;
    for (const n of TRANSITIONS[s]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, s);
      if (n === to) {
        const path: ExecutionState[] = [to];
        let c = to;
        while (prev.get(c) && prev.get(c) !== from) {
          c = prev.get(c)!;
          path.unshift(c);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

export const STATE_LABEL: Record<ExecutionState, string> = {
  APPROVED: 'Approved',
  READY_FOR_EXECUTION: 'Ready for execution',
  SCHEDULED: 'Scheduled',
  QUEUED: 'Queued',
  EXECUTING: 'Publishing',
  COMPLETED: 'Published',
  FAILED: 'Failed',
  ACTION_REQUIRED: 'Action required',
  CANCELLED: 'Cancelled',
};

export const STATE_TONE: Record<ExecutionState, 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger' | 'muted'> = {
  APPROVED: 'neutral',
  READY_FOR_EXECUTION: 'info',
  SCHEDULED: 'info',
  QUEUED: 'progress',
  EXECUTING: 'progress',
  COMPLETED: 'success',
  FAILED: 'danger',
  ACTION_REQUIRED: 'warning',
  CANCELLED: 'muted',
};

export const TERMINAL: ReadonlySet<ExecutionState> = new Set(['COMPLETED']);
/** States a person can cancel from. */
export const CANCELLABLE: ReadonlySet<ExecutionState> = new Set(['READY_FOR_EXECUTION', 'SCHEDULED', 'QUEUED', 'FAILED', 'ACTION_REQUIRED', 'APPROVED']);
/** States a person can retry from. */
export const RETRYABLE: ReadonlySet<ExecutionState> = new Set(['FAILED', 'ACTION_REQUIRED']);

// --- Failure classification -------------------------------------------------

export type FailureKind =
  /** The provider definitely refused and asked to wait: safe to retry automatically. */
  | 'rate_limited'
  /** The connection needs a person (expired, revoked, missing permission). */
  | 'connection'
  /** The content or media isn't acceptable to the provider. */
  | 'content'
  /** Routing refused it before execution (unsupported, no account…). */
  | 'routing'
  /** The attempt may or may not have reached the provider — a person must check. */
  | 'unknown_outcome'
  /** Anything else the provider refused. */
  | 'provider';

/** Backoff for automatic retries (rate limits only). */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/** Where a failure leaves the execution. */
export function failureTarget(kind: FailureKind, attemptCount: number, maxAttempts: number): { state: 'FAILED' | 'ACTION_REQUIRED'; retryInMs: number | null } {
  if (kind === 'rate_limited' && attemptCount < maxAttempts) {
    return { state: 'FAILED', retryInMs: RETRY_BACKOFF_MS[Math.min(attemptCount - 1, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[0]! };
  }
  if (kind === 'provider' || kind === 'rate_limited') return { state: 'FAILED', retryInMs: null };
  return { state: 'ACTION_REQUIRED', retryInMs: null };
}

/** A provider's message → what kind of failure it is. */
export function classifyFailure(message: string, opts: { credentialRejected?: boolean; thrown?: boolean } = {}): FailureKind {
  if (opts.credentialRejected) return 'connection';
  if (/rate-limit|rate limit|too many|25 posts per 24 hours|HTTP 429/i.test(message)) return 'rate_limited';
  if (/interrupted|check the account for the post/i.test(message)) return 'unknown_outcome';
  if (/reconnect|isn.t connected|not connected|expired|credentials|permission|not permitted|App Review|revoked|Connections/i.test(message)) return 'connection';
  if (/image|video|media|graphic|caption|format|carousel|aspect|resolution|JPEG|must have/i.test(message)) return 'content';
  // A thrown error (timeout, network) may have reached the provider.
  if (opts.thrown && /timed? ?out|ECONN|socket|network|fetch failed|could not be reached/i.test(message)) return 'unknown_outcome';
  return 'provider';
}
