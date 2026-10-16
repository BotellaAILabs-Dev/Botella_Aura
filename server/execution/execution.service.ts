import type { ExecutionHandoff as HandoffRow } from '@prisma/client';

import { db } from '@/lib/db';
import type { ExecutionHandoff } from '@/lib/execution-handoff';
import { readExecutionHandoff } from '@/lib/execution-handoff';

/**
 * THE EXECUTION SERVICE seam — where approved work is passed once its handoff
 * is prepared (server/execution/execution-handoff.service.ts).
 *
 * Sprint 10 builds the Execution Engine. Until then the service is an OUTBOX:
 * the ExecutionHandoff row IS the queue, `accept` records that a READY
 * package was handed over, and nothing is executed. Sprint 10 registers its
 * engine with `setExecutionService` and consumes READY handoffs with
 * `listReadyHandoffs` — the approval model and the payload stay as they are.
 *
 * The engine must re-check each handoff right before acting on it
 * (`getExecutionHandoff` recomputes it): connections expire and content can
 * be reopened between preparation and execution.
 */

export interface ExecutionService {
  /** A handoff became READY. The default only records it; Sprint 10 may act. */
  accept(handoff: ExecutionHandoff): Promise<void>;
}

/** Until Sprint 10: the stored row is the outbox; nothing runs. */
const outbox: ExecutionService = {
  async accept() {
    /* recorded by the caller (the ExecutionHandoff row + audit) */
  },
};

let current: ExecutionService = outbox;

/** Sprint 10: register the Execution Engine. */
export function setExecutionService(service: ExecutionService): void {
  current = service;
}

export function executionService(): ExecutionService {
  return current;
}

export interface ReadyHandoff {
  id: string;
  companyId: string;
  contentDraftId: string;
  platform: string;
  scheduledFor: Date | null;
  payload: ExecutionHandoff;
}

/**
 * READY handoffs for the engine to consume, oldest first; `dueBefore` keeps
 * those whose time has come (unscheduled ones are always due).
 */
export async function listReadyHandoffs(args: { companyId?: string; dueBefore?: Date; limit?: number } = {}): Promise<ReadyHandoff[]> {
  const rows: HandoffRow[] = await db.executionHandoff.findMany({
    where: {
      status: 'READY',
      ...(args.companyId ? { companyId: args.companyId } : {}),
      ...(args.dueBefore ? { OR: [{ scheduledFor: null }, { scheduledFor: { lte: args.dueBefore } }] } : {}),
    },
    orderBy: { preparedAt: 'asc' },
    take: args.limit ?? 100,
  });
  return rows.flatMap((r) => {
    const payload = readExecutionHandoff(r.payload);
    return payload
      ? [{ id: r.id, companyId: r.companyId, contentDraftId: r.contentDraftId, platform: r.platform, scheduledFor: r.scheduledFor, payload }]
      : [];
  });
}
