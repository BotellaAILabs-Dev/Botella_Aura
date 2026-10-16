/**
 * THE EXECUTION GATE for work created from Aura's recommendations through the
 * Campaign and Outreach creation handoffs (lib/creation-handoff.ts).
 *
 * Creation is live: a campaign plan or outreach drafts can be made from a
 * recommendation, keep its context, and go through the normal approval model.
 * EXECUTION is not: until Sprint 10's execution state machine arrives,
 *
 *   campaigns   are saved as a plan (status DRAFT) — the daily executor never
 *               runs their tasks, and they cannot be started or resumed;
 *   outreach    messages can be reviewed, edited and approved, but never enter
 *               the extension's send queue and cannot be marked sent.
 *
 * Approval is unaffected: approved work simply waits at "Ready for execution"
 * (lib/approval.ts), which is exactly where Sprint 10 picks it up. Sprint 10
 * turns this on in ONE place — CONTEXTUAL_EXECUTION_ENABLED — and every guard
 * (executor, campaign status, extension queue, mark-sent) follows.
 *
 * Work created any other way (a campaign planned from scratch, outreach drafted
 * for a lead) keeps its existing behaviour. Pure and client-safe.
 */

/** Sprint 10 flips this. Nothing else needs to change. */
export const CONTEXTUAL_EXECUTION_ENABLED = false;

/** When execution for this work arrives. */
export const EXECUTION_AVAILABLE_IN = 'Sprint 10';

export type GatedKind = 'campaign' | 'outreach';

/** What the person is told, in plain words. */
export const EXECUTION_BLOCKED_MESSAGE: Record<GatedKind, string> = {
  campaign:
    'Running campaigns planned from Aura’s suggestions isn’t switched on yet — it arrives with execution. The plan is saved: review it now, and nothing is generated or sent until then.',
  outreach:
    'Sending outreach drafted from Aura’s suggestions isn’t switched on yet — it arrives with execution. Review and approve the messages now; approved ones wait, and nothing is sent until then.',
};

export interface ExecutionGate {
  blocked: boolean;
  /** Why, when blocked. */
  message: string | null;
}

/**
 * Whether a piece of work may execute. `contextual` = it was created through
 * a recommendation creation handoff (it carries a creation context).
 */
export function executionGate(kind: GatedKind, contextual: boolean): ExecutionGate {
  const blocked = contextual && !CONTEXTUAL_EXECUTION_ENABLED;
  return { blocked, message: blocked ? EXECUTION_BLOCKED_MESSAGE[kind] : null };
}

/** An item's stored creation context marks it as made through a handoff. */
export function hasCreationContext(meta: unknown): boolean {
  return Boolean(
    meta && typeof meta === 'object' && (meta as Record<string, unknown>).creationContext,
  );
}
