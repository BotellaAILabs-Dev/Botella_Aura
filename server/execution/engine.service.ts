import type { ContentPublication, Execution, ExecutionStatus, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { approvalOf } from '@/lib/approval';
import { traceOf } from '@/lib/trace';
import { readExecutionHandoff } from '@/lib/execution-handoff';
import {
  assertTransition,
  classifyFailure,
  failureTarget,
  InvalidTransitionError,
  pathTo,
  STATE_LABEL,
  type ExecutionState,
} from '@/lib/execution-state';
import type { RouteDecision } from '@/lib/execution-routing';
import { formatInZone } from '@/lib/timezone';
import { recordAudit } from '@/server/services/audit.service';

/**
 * The execution engine: one Execution per (post, network), moved through
 * lib/execution-state.ts by what actually happens —
 *
 *   approval / handoff      syncFromHandoff     APPROVED → READY / SCHEDULED, or ACTION_REQUIRED
 *   a publish is claimed    syncFromPublication → QUEUED → EXECUTING (attempt + 1)
 *   the provider answers    syncFromPublication → COMPLETED / FAILED / ACTION_REQUIRED
 *   routing                 recordRoute          provider, connection, account, page
 *   a person                cancelExecution, retry (server/execution/execution-actions.service.ts)
 *
 * Every change is a compare-and-swap on the current status, is checked
 * against the state machine, and is recorded as an ExecutionEvent. The
 * publication store (server/content/publication-store.ts) stays the guard
 * against posting twice; this is the lifecycle around it.
 */

export type Actor = 'person' | 'scheduler' | 'system' | 'provider';

interface Change {
  actor: Actor;
  actorUserId?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
  /** Other fields to write with the change. */
  data?: Prisma.ExecutionUpdateManyMutationInput;
}

const PLATFORM_LABEL: Record<string, string> = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn', X: 'X' };

/** The execution for a (post, network), created APPROVED with its trace when first needed. */
export async function ensureExecution(args: { companyId: string; draftId: string; platform: string; userId?: string | null }): Promise<Execution | null> {
  const key = { contentDraftId_platform: { contentDraftId: args.draftId, platform: args.platform as Execution['platform'] } };
  const existing = await db.execution.findUnique({ where: key });
  if (existing) return existing;
  const draft = await db.contentDraft.findFirst({
    where: { id: args.draftId, companyId: args.companyId },
    include: { media: { orderBy: { position: 'asc' }, select: { assetId: true } } },
  });
  if (!draft) return null;
  const trace = traceOf(draft.aiMetadata);
  const approval = approvalOf(draft.aiMetadata);
  const provenance = ((draft.aiMetadata ?? {}) as { recommendation?: { recommendationId?: string; id?: string; opportunityId?: string } }).recommendation ?? null;
  try {
    const row = await db.execution.create({
      data: {
        companyId: args.companyId,
        contentDraftId: draft.id,
        platform: args.platform as Execution['platform'],
        status: 'APPROVED',
        traceId: trace?.traceId ?? null,
        businessContextRevision: trace?.businessContext.revision ?? null,
        opportunityId: trace?.opportunityId ?? provenance?.opportunityId ?? null,
        recommendationId: trace?.recommendationId ?? provenance?.recommendationId ?? provenance?.id ?? null,
        approvalId: trace?.approvalId ?? approval?.approved?.id ?? null,
        approvedVersion: approval?.approved?.version ?? trace?.approvedVersion ?? null,
        contentHash: approval?.approved?.hash ?? null,
        assetIds: draft.media.map((m) => m.assetId),
        scheduledFor: draft.scheduledFor,
        createdById: args.userId ?? null,
      },
    });
    await db.executionEvent.create({
      data: { executionId: row.id, companyId: row.companyId, from: null, to: 'APPROVED', actor: args.userId ? 'person' : 'system', actorUserId: args.userId ?? null, reason: 'Approved for execution.' },
    });
    return row;
  } catch (err) {
    // Created by a concurrent call — use that one.
    const again = await db.execution.findUnique({ where: key });
    if (again) return again;
    throw err;
  }
}

/**
 * Move an execution to `to`, through the allowed path (each step recorded).
 * Compare-and-swap on the status: a concurrent change wins, and this returns
 * the row as that change left it. Throws InvalidTransitionError when `to`
 * can't be reached (e.g. COMPLETED → anything).
 */
export async function moveExecution(execution: Execution, to: ExecutionState, change: Change): Promise<Execution> {
  const from = execution.status as ExecutionState;
  const steps = from === to ? (canSelf(to) ? [to] : []) : pathTo(from, to);
  if (steps === null) throw new InvalidTransitionError(from, to);
  if (steps.length === 0) {
    if (change.data && Object.keys(change.data).length) {
      await db.execution.update({ where: { id: execution.id }, data: change.data });
    }
    return (await db.execution.findUnique({ where: { id: execution.id } }))!;
  }
  let current = execution;
  for (let i = 0; i < steps.length; i++) {
    const next = steps[i]!;
    const last = i === steps.length - 1;
    assertTransition(current.status as ExecutionState, next);
    const moved = await db.execution.updateMany({
      where: { id: current.id, status: current.status, updatedAt: current.updatedAt },
      data: { status: next as ExecutionStatus, ...(last ? (change.data ?? {}) : {}) },
    });
    if (moved.count !== 1) {
      // Someone else moved it: report the state it is in now.
      logger.info('execution: concurrent change, skipped', { executionId: current.id, from: current.status, to: next });
      return (await db.execution.findUnique({ where: { id: current.id } }))!;
    }
    await db.executionEvent.create({
      data: {
        executionId: current.id,
        companyId: current.companyId,
        from: current.status,
        to: next as ExecutionStatus,
        actor: change.actor,
        actorUserId: change.actorUserId ?? null,
        reason: last ? (change.reason ?? null) : null,
        detail: (last ? (change.detail ?? {}) : {}) as Prisma.InputJsonObject,
      },
    });
    current = (await db.execution.findUnique({ where: { id: current.id } }))!;
  }
  if (from !== current.status || from === to) {
    await recordAudit({
      action: 'EXECUTION_STATE_CHANGED',
      userId: change.actorUserId ?? null,
      companyId: current.companyId,
      metadata: {
        executionId: current.id,
        draftId: current.contentDraftId,
        platform: current.platform,
        from,
        to: current.status,
        actor: change.actor,
        ...(change.reason ? { reason: change.reason.slice(0, 300) } : {}),
      },
    });
  }
  return current;
}

function canSelf(state: ExecutionState): boolean {
  return state === 'SCHEDULED' || state === 'EXECUTING';
}

/** Never let lifecycle bookkeeping break the action it describes. */
async function safely<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      logger.warn(`execution: ${what} refused by the state machine`, { from: err.from, to: err.to });
    } else {
      logger.error(`execution: ${what} failed`, { error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}

const PRE_EXECUTION: ReadonlySet<ExecutionState> = new Set(['APPROVED', 'READY_FOR_EXECUTION', 'SCHEDULED', 'QUEUED', 'FAILED', 'ACTION_REQUIRED']);

/**
 * After the Approval → Execution handoff is prepared or refreshed: the
 * execution follows it. READY → Ready for execution (or Scheduled, when it has
 * a future time); BLOCKED → Action required with the first issue; content
 * reopened or changed → Cancelled. Never touches one that is executing or done.
 */
export async function syncFromHandoff(args: { companyId: string; draftId: string; platform: string; userId?: string | null }): Promise<Execution | null> {
  return safely('sync from handoff', async () => {
    const [draft, handoffRow] = await Promise.all([
      db.contentDraft.findFirst({ where: { id: args.draftId, companyId: args.companyId }, select: { id: true, status: true, scheduledFor: true, aiMetadata: true } }),
      db.executionHandoff.findUnique({ where: { contentDraftId_platform: { contentDraftId: args.draftId, platform: args.platform as Execution['platform'] } } }),
    ]);
    if (!draft) return null;
    let execution = await db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: args.draftId, platform: args.platform as Execution['platform'] } } });
    const approved = draft.status === 'APPROVED';
    if (!execution) {
      if (!approved || !handoffRow) return null;
      execution = await ensureExecution(args);
      if (!execution) return null;
    }
    const state = execution.status as ExecutionState;
    if (!PRE_EXECUTION.has(state) && state !== 'CANCELLED') return execution;

    // Approval withdrawn, or the content changed since it was approved.
    if (!approved || handoffRow?.status === 'SUPERSEDED') {
      if (state === 'CANCELLED' || draft.status === 'PUBLISHED') return execution;
      return moveExecution(execution, 'CANCELLED', {
        actor: args.userId ? 'person' : 'system',
        actorUserId: args.userId,
        reason: !approved ? 'The approval was withdrawn — it needs approving again.' : 'The content changed after approval — it needs approving again.',
        data: { cancelledAt: new Date(), nextAttemptAt: null },
      });
    }
    if (!handoffRow) return execution;
    const handoff = readExecutionHandoff(handoffRow.payload);
    const identity: Prisma.ExecutionUpdateManyMutationInput = {
      handoffId: handoffRow.id,
      contentHash: handoffRow.contentHash,
      approvedVersion: handoffRow.contentVersion,
      scheduledFor: draft.scheduledFor,
      ...(handoff?.provider ? { provider: handoff.provider.id } : {}),
      ...(handoff?.account?.id ? { targetExternalId: handoff.account.id, targetKind: handoff.account.kind, targetName: handoff.account.label } : {}),
    };
    if (state === 'CANCELLED') {
      // Back only when approved again after it was cancelled; a cancelled
      // execution otherwise stays cancelled (publishing it is a person's call).
      const approvedAt = approvalOf(draft.aiMetadata)?.approved?.at;
      const reapproved = approvedAt && execution.cancelledAt && new Date(approvedAt).getTime() > execution.cancelledAt.getTime();
      if (!reapproved) return execution;
      execution = await moveExecution(execution, 'APPROVED', { actor: 'system', actorUserId: args.userId, reason: 'Approved again.', data: { cancelledAt: null } });
    }

    if (handoffRow.status === 'BLOCKED') {
      const issues = (handoff?.readiness.issues ?? []) as { code: string; message: string }[];
      const first = issues[0];
      if (execution.status === 'ACTION_REQUIRED' && execution.errorCode === (first?.code ?? null)) {
        return moveExecution(execution, 'ACTION_REQUIRED', { actor: 'system', data: identity });
      }
      // A failed attempt keeps its own error; a block found later is added on top.
      return moveExecution(execution, 'ACTION_REQUIRED', {
        actor: 'system',
        actorUserId: args.userId,
        reason: first?.message ?? 'It can’t be executed yet.',
        detail: { issues: issues.map((i) => i.code) },
        data: { ...identity, errorCode: first?.code ?? 'blocked', errorMessage: issues.map((i) => i.message).join(' ').slice(0, 2000), lastErrorAt: new Date() },
      });
    }

    // READY: scheduled for later, or waiting for "publish now".
    const future = draft.scheduledFor && draft.scheduledFor.getTime() > Date.now();
    const target: ExecutionState = future ? 'SCHEDULED' : 'READY_FOR_EXECUTION';
    const rescheduled = execution.status === 'SCHEDULED' && future && execution.scheduledFor?.getTime() !== draft.scheduledFor!.getTime();
    // A FAILED one awaiting a retry, or one already queued, stays where it is.
    if ((execution.status === 'FAILED' && execution.nextAttemptAt) || execution.status === 'QUEUED') {
      await db.execution.update({ where: { id: execution.id }, data: identity });
      return db.execution.findUnique({ where: { id: execution.id } });
    }
    if (execution.status === target && !rescheduled) {
      await db.execution.update({ where: { id: execution.id }, data: identity });
      return db.execution.findUnique({ where: { id: execution.id } });
    }
    const tz = execution.scheduledTimeZone ?? 'UTC';
    return moveExecution(execution, target, {
      actor: args.userId ? 'person' : 'system',
      actorUserId: args.userId,
      reason: future
        ? rescheduled
          ? `Rescheduled from ${formatInZone(execution.scheduledFor!, tz)} to ${formatInZone(draft.scheduledFor!, tz)}.`
          : `Scheduled for ${formatInZone(draft.scheduledFor!, tz)}.`
        : 'Ready — publishes when a person publishes it.',
      detail: future ? { scheduledFor: draft.scheduledFor!.toISOString(), previous: execution.scheduledFor?.toISOString() ?? null } : {},
      data: { ...identity, errorCode: null, errorMessage: null, ...(future ? {} : {}) },
    });
  });
}

/** The person's chosen wall time and zone, kept with the UTC instant. */
export async function noteSchedule(args: { companyId: string; draftId: string; timeZone: string; local: string | null }): Promise<void> {
  await safely('note schedule', () =>
    db.execution.updateMany({
      where: { companyId: args.companyId, contentDraftId: args.draftId, status: { in: ['APPROVED', 'READY_FOR_EXECUTION', 'SCHEDULED', 'FAILED', 'ACTION_REQUIRED'] } },
      data: { scheduledTimeZone: args.timeZone, scheduledLocal: args.local },
    }),
  );
}

/** Routing decided where it goes (or why it can't): stored on the execution. */
export async function recordRoute(args: { companyId: string; draftId: string; platform: string; route: RouteDecision; userId?: string | null }): Promise<void> {
  await safely('record route', async () => {
    const execution = await ensureExecution(args);
    if (!execution) return;
    const r = args.route;
    if (r.ok) {
      await db.execution.update({
        where: { id: execution.id },
        data: {
          provider: r.provider,
          connectorId: r.connectorId,
          connectionId: r.connectionId,
          connectedAccountId: r.target.connectedAccountId,
          targetKind: r.target.kind,
          targetExternalId: r.target.externalId,
          targetName: r.target.name,
        },
      });
      return;
    }
    await db.execution.update({
      where: { id: execution.id },
      data: { provider: r.provider, connectorId: r.connectorId, connectionId: r.connectionId },
    });
    // Refused before execution: a person has to act.
    if (PRE_EXECUTION.has(execution.status as ExecutionState) || execution.status === 'CANCELLED') {
      await moveExecution(execution, 'ACTION_REQUIRED', {
        actor: 'system',
        actorUserId: args.userId,
        reason: r.message,
        detail: { route: r.code, checks: r.checks },
        data: { errorCode: `route:${r.code}`, errorMessage: r.message, lastErrorAt: new Date() },
      });
    }
  });
}

/**
 * The publication record changed (claimed, answered, processing finished):
 * the execution follows. Called by server/content/publication-store.ts and
 * the processing sweep; never throws.
 */
export async function syncFromPublication(
  publication: Pick<ContentPublication, 'companyId' | 'contentDraftId' | 'platform' | 'status' | 'attempts' | 'url' | 'externalId' | 'message' | 'requestedById' | 'startedAt' | 'publishedAt'>,
  opts: { automatic?: boolean; thrown?: boolean; providerExternalId?: string | null; event?: 'claimed' | 'finished' | 'refused' } = {},
): Promise<Execution | null> {
  return safely('sync from publication', async () => {
    let execution = await ensureExecution({ companyId: publication.companyId, draftId: publication.contentDraftId, platform: publication.platform, userId: publication.requestedById });
    if (!execution) return null;
    const actor: Actor = opts.automatic ? 'scheduler' : publication.requestedById ? 'person' : 'system';
    const who = { actor, actorUserId: publication.requestedById ?? null };

    switch (publication.status) {
      case 'PUBLISHING': {
        if (execution.status === 'EXECUTING') return execution;
        const late =
          opts.automatic && execution.scheduledFor ? Math.max(0, (publication.startedAt ?? new Date()).getTime() - execution.scheduledFor.getTime()) : null;
        // Reaching the provider: through QUEUED (recorded), then EXECUTING.
        if (execution.status !== 'QUEUED') {
          execution = await moveExecution(execution, 'QUEUED', {
            ...who,
            reason: opts.automatic ? 'Due — queued by the scheduler.' : 'Queued to publish now.',
            detail: late !== null ? { scheduledFor: execution.scheduledFor?.toISOString(), lateByMs: late } : {},
            data: { nextAttemptAt: null },
          });
        }
        return moveExecution(execution, 'EXECUTING', {
          ...who,
          reason: `Publishing to ${PLATFORM_LABEL[publication.platform] ?? publication.platform} (attempt ${publication.attempts}).`,
          data: { attemptCount: publication.attempts, startedAt: publication.startedAt ?? new Date(), errorCode: null, errorMessage: null },
        });
      }
      case 'PROCESSING': {
        return moveExecution(execution, 'EXECUTING', {
          actor: 'provider',
          reason: publication.message ?? 'Accepted by the network, still processing.',
          data: { providerResponse: { state: 'processing', pending: publication.externalId } as Prisma.InputJsonObject },
        });
      }
      case 'PUBLISHED': {
        if (execution.status === 'COMPLETED') return execution;
        return moveExecution(execution, 'COMPLETED', {
          actor: 'provider',
          actorUserId: publication.requestedById,
          reason: publication.url ? `Published: ${publication.url}` : 'Published.',
          data: {
            completedAt: publication.publishedAt ?? new Date(),
            url: publication.url,
            externalId: opts.providerExternalId ?? execution.externalId,
            providerResponse: { state: 'published', url: publication.url, id: opts.providerExternalId ?? null } as Prisma.InputJsonObject,
            errorCode: null,
            errorMessage: null,
            nextAttemptAt: null,
          },
        });
      }
      case 'FAILED':
      case 'MANUAL': {
        const message = publication.message ?? 'The network did not publish it.';
        const kind = classifyFailure(message, { thrown: opts.thrown });
        // A claim refused because an earlier attempt was interrupted, while
        // the execution never saw the attempt: record it as unknown outcome.
        const attempts = Math.max(publication.attempts, execution.attemptCount);
        const { state, retryInMs } = failureTarget(kind, attempts, execution.maxAttempts);
        if (execution.status !== 'EXECUTING' && !PRE_EXECUTION.has(execution.status as ExecutionState)) return execution;
        // From before execution, the allowed path is walked (and recorded):
        // e.g. QUEUED → EXECUTING → FAILED.
        return moveExecution(execution, state, {
          actor: 'provider',
          actorUserId: publication.requestedById,
          reason: retryInMs ? `${message} Aura retries automatically in ${Math.round(retryInMs / 60_000)} min.` : message,
          detail: { kind, attempt: attempts },
          data: {
            attemptCount: attempts,
            errorCode: kind,
            errorMessage: message.slice(0, 2000),
            lastErrorAt: new Date(),
            nextAttemptAt: retryInMs ? new Date(Date.now() + retryInMs) : null,
            providerResponse: { state: publication.status.toLowerCase(), message: message.slice(0, 500) } as Prisma.InputJsonObject,
          },
        });
      }
      default:
        return execution;
    }
  });
}

/** Mark the person-facing label for a status. */
export function executionLabel(status: string): string {
  return STATE_LABEL[status as ExecutionState] ?? status;
}
