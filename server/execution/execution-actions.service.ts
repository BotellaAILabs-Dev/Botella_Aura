import type { CompanyRole, Execution, ExecutionStatus } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { can } from '@/lib/rbac';
import { CANCELLABLE, RETRYABLE, STATE_LABEL, type ExecutionState } from '@/lib/execution-state';
import { formatInZone, safeTimeZone } from '@/lib/timezone';
import type { SocialPlatformKey } from '@/lib/platforms';
import { moveExecution } from '@/server/execution/engine.service';
import { routeExecution } from '@/server/execution/routing.service';
import { resolveTrace } from '@/server/trace/trace.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * What people (and the scheduler) do with executions:
 *
 *   listExecutions / getExecutionDetail   state, history, and the trace
 *                                         Business Context → … → Execution
 *   cancelExecution                       Scheduled (or waiting) → Cancelled
 *   retryExecution                        Failed / Action required → run again now
 *   runExecutionSweep                     the scheduler's automatic retries
 */

export class ExecutionActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ExecutionActionError';
  }
}

async function owned(companyId: string, id: string): Promise<Execution> {
  const row = await db.execution.findFirst({ where: { id, companyId } });
  if (!row) throw new ExecutionActionError('Not found.', 404);
  return row;
}

export async function listExecutions(args: { companyId: string; status?: ExecutionStatus[]; draftId?: string; limit?: number }) {
  const rows = await db.execution.findMany({
    where: {
      companyId: args.companyId,
      ...(args.status?.length ? { status: { in: args.status } } : {}),
      ...(args.draftId ? { contentDraftId: args.draftId } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: Math.min(args.limit ?? 100, 200),
    include: { contentDraft: { select: { id: true, title: true, type: true, status: true } } },
  });
  return rows.map(view);
}

export type ExecutionView = ReturnType<typeof view>;

function view(e: Execution & { contentDraft?: { id: string; title: string | null; type: string; status: string } | null }) {
  const state = e.status as ExecutionState;
  return {
    id: e.id,
    workspaceId: e.companyId,
    contentId: e.contentDraftId,
    contentTitle: e.contentDraft?.title ?? null,
    contentType: e.contentDraft?.type ?? null,
    channel: e.platform,
    provider: e.provider,
    connectionId: e.connectionId,
    connectedAccountId: e.connectedAccountId,
    target: e.targetExternalId ? { kind: e.targetKind, id: e.targetExternalId, name: e.targetName } : null,
    trace: {
      traceId: e.traceId,
      businessContextRevision: e.businessContextRevision,
      opportunityId: e.opportunityId,
      recommendationId: e.recommendationId,
      approvalId: e.approvalId,
      approvedVersion: e.approvedVersion,
      contentHash: e.contentHash,
      assetIds: e.assetIds,
    },
    status: state,
    statusLabel: STATE_LABEL[state] ?? state,
    scheduledFor: e.scheduledFor?.toISOString() ?? null,
    scheduledTimeZone: e.scheduledTimeZone,
    scheduledLocal: e.scheduledLocal,
    attemptCount: e.attemptCount,
    maxAttempts: e.maxAttempts,
    nextAttemptAt: e.nextAttemptAt?.toISOString() ?? null,
    startedAt: e.startedAt?.toISOString() ?? null,
    completedAt: e.completedAt?.toISOString() ?? null,
    cancelledAt: e.cancelledAt?.toISOString() ?? null,
    providerResponse: e.providerResponse,
    externalId: e.externalId,
    url: e.url,
    error: e.errorCode ? { code: e.errorCode, message: e.errorMessage, at: e.lastErrorAt?.toISOString() ?? null } : null,
    canCancel: CANCELLABLE.has(state),
    canRetry: RETRYABLE.has(state),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** One execution, its every state change, and the chain it came from. */
export async function getExecutionDetail(companyId: string, id: string) {
  const row = await db.execution.findFirst({
    where: { id, companyId },
    include: {
      contentDraft: { select: { id: true, title: true, type: true, status: true } },
      events: { orderBy: { at: 'asc' } },
    },
  });
  if (!row) return null;
  const trace = await resolveTrace(companyId, row.contentDraftId);
  return {
    execution: view(row),
    events: row.events.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      fromLabel: e.from ? (STATE_LABEL[e.from as ExecutionState] ?? e.from) : null,
      toLabel: STATE_LABEL[e.to as ExecutionState] ?? e.to,
      actor: e.actor,
      actorUserId: e.actorUserId,
      reason: e.reason,
      detail: e.detail,
      at: e.at.toISOString(),
    })),
    // Business Context → Opportunity → Recommendation → Content → Approval → Execution
    chain: {
      businessContext: trace?.businessContext ?? { revision: row.businessContextRevision, name: null, description: null, fields: [] },
      opportunity: trace?.opportunity ?? (row.opportunityId ? { id: row.opportunityId } : null),
      recommendation: trace?.recommendation ?? (row.recommendationId ? { id: row.recommendationId } : null),
      content: { id: row.contentDraftId, title: row.contentDraft?.title ?? null, type: row.contentDraft?.type ?? null },
      approval: trace?.approved ?? (row.approvalId ? { id: row.approvalId, version: row.approvedVersion } : null),
      execution: { id: row.id, status: row.status, url: row.url },
      gaps: trace?.gaps ?? [],
    },
  };
}

/** A person cancels it (Scheduled → Cancelled). It will not run unless published by a person. */
export async function cancelExecution(args: { companyId: string; userId: string; role: CompanyRole; id: string; reason?: string | null }) {
  if (!can(args.role, 'content:publish')) throw new ExecutionActionError('Only owners and admins can cancel publishing.', 403);
  const row = await owned(args.companyId, args.id);
  const state = row.status as ExecutionState;
  if (!CANCELLABLE.has(state)) {
    throw new ExecutionActionError(
      state === 'COMPLETED' ? 'It has already been published.' : state === 'EXECUTING' ? 'It is being published right now — it can’t be cancelled.' : `It is ${STATE_LABEL[state].toLowerCase()}.`,
      409,
      'not_cancellable',
    );
  }
  const draft = await db.contentDraft.findUnique({ where: { id: row.contentDraftId }, select: { scheduledFor: true, platform: true, type: true } });
  const moved = await moveExecution(row, 'CANCELLED', {
    actor: 'person',
    actorUserId: args.userId,
    reason: args.reason?.trim() ? `Cancelled: ${args.reason.trim().slice(0, 300)}` : 'Cancelled by a person.',
    data: { cancelledAt: new Date(), nextAttemptAt: null },
  });
  if (moved.status !== 'CANCELLED') throw new ExecutionActionError('It changed while you were cancelling it — refresh and try again.', 409, 'concurrent_change');
  // The draft's own schedule goes too, so the scheduler never picks it up.
  if (draft?.scheduledFor) {
    const others = await db.execution.count({ where: { contentDraftId: row.contentDraftId, id: { not: row.id }, status: 'SCHEDULED' } });
    if (others === 0) await db.contentDraft.update({ where: { id: row.contentDraftId }, data: { scheduledFor: null } });
  }
  return view(moved);
}

/** A person runs it again now (Failed / Action required). Re-routed first. */
export async function retryExecution(args: { companyId: string; userId: string; role: CompanyRole; id: string }) {
  if (!can(args.role, 'content:publish')) throw new ExecutionActionError('Only owners and admins can publish.', 403);
  const row = await owned(args.companyId, args.id);
  const state = row.status as ExecutionState;
  if (!RETRYABLE.has(state)) {
    throw new ExecutionActionError(state === 'COMPLETED' ? 'It has already been published — it can’t run again.' : `Only failed executions can be retried; this one is ${STATE_LABEL[state].toLowerCase()}.`, 409, 'not_retryable');
  }
  const draft = await db.contentDraft.findUnique({ where: { id: row.contentDraftId }, select: { type: true } });
  const route = await routeExecution({
    companyId: args.companyId,
    platform: row.platform,
    contentType: draft?.type ?? 'LINKEDIN_POST',
    record: { draftId: row.contentDraftId, executionId: row.id, userId: args.userId },
  });
  if (!route.ok && route.code !== 'not_connected') {
    throw new ExecutionActionError(route.message, 409, `route:${route.code}`);
  }
  const { publishDraft } = await import('@/server/content/publish.service');
  const result = await publishDraft({ companyId: args.companyId, userId: args.userId, draftId: row.contentDraftId, platform: row.platform as SocialPlatformKey });
  await recordAudit({ action: 'CONTENT_PUBLISH_REQUESTED', userId: args.userId, companyId: args.companyId, metadata: { draftId: row.contentDraftId, platform: row.platform, retry: true } });
  const after = await db.execution.findUnique({ where: { id: row.id } });
  return { result, execution: after ? view(after) : null };
}

/**
 * The scheduler's pass for executions (called with the scheduled publish job):
 * rate-limited attempts whose backoff is over are retried, up to maxAttempts.
 * Nothing else is ever retried automatically — an attempt whose outcome is
 * unknown could post twice.
 */
export async function runExecutionSweep(now: Date = new Date()): Promise<{ retried: number; retryFailed: number }> {
  const due = await db.execution.findMany({
    where: { status: 'FAILED', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 50,
  });
  let retried = 0;
  let retryFailed = 0;
  const { publishDraft } = await import('@/server/content/publish.service');
  for (const e of due) {
    if (e.attemptCount >= e.maxAttempts) continue;
    try {
      const r = await publishDraft({ companyId: e.companyId, userId: null, draftId: e.contentDraftId, automatic: true, retry: true, platform: e.platform as SocialPlatformKey });
      if (r.mode === 'published' || r.mode === 'processing') retried++;
      else retryFailed++;
    } catch (err) {
      retryFailed++;
      logger.error('execution: automatic retry failed', { executionId: e.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { retried, retryFailed };
}

/** Draft ids whose execution for their own network was cancelled (the scheduler skips them). */
export async function cancelledFor(drafts: { id: string; platform: string }[]): Promise<Set<string>> {
  if (!drafts.length) return new Set();
  const rows = await db.execution.findMany({
    where: { contentDraftId: { in: drafts.map((d) => d.id) }, status: 'CANCELLED' },
    select: { contentDraftId: true, platform: true },
  });
  const own = new Map(drafts.map((d) => [d.id, d.platform]));
  return new Set(rows.filter((r) => own.get(r.contentDraftId) === r.platform).map((r) => r.contentDraftId));
}

/** "Scheduled for Mon 2 Nov 2026, 09:00 GMT" in the workspace's zone. */
export function scheduleLine(at: Date | string, tz: string | null | undefined): string {
  return `Scheduled for ${formatInZone(at, safeTimeZone(tz))}`;
}
