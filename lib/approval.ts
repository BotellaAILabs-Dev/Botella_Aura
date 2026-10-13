/**
 * The unified approval model: one set of states, transitions and approval
 * records for Content Studio drafts, campaign tasks and outreach messages.
 * Pure and client-safe; server/approval/approval.service.ts applies it.
 *
 * Each module keeps its own status column (and its own meaning for it — a
 * published post, a sent message); the unified state is DERIVED from it plus
 * the schedule, so nothing has to be migrated and Sprint 10's execution
 * states can take over from READY_FOR_EXECUTION without a rename.
 *
 * What an approval covers is fingerprinted: for content, the text, the
 * network and the attached images; for outreach, the message. An approved
 * item whose fingerprint no longer matches cannot be scheduled, queued or
 * published — so approved work cannot silently change. Any edit to approved
 * work reopens it, visibly, with the change recorded.
 */

export const APPROVAL_STATES = [
  'draft',
  'generated',
  'review_required',
  'approved',
  'rejected',
  'scheduled',
  'ready_for_execution',
  'executed',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const APPROVAL_STATE_LABEL: Record<ApprovalState, string> = {
  draft: 'Draft',
  generated: 'Generated',
  review_required: 'Review required',
  approved: 'Approved',
  rejected: 'Rejected',
  scheduled: 'Scheduled',
  ready_for_execution: 'Ready for execution',
  executed: 'Executed',
};

export type ApprovalAction =
  | 'generated'
  | 'edited'
  | 'regenerated'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'reopened'
  | 'scheduled'
  | 'unscheduled'
  | 'media_changed'
  | 'retargeted'
  | 'executed';

/**
 * Allowed moves. "approved → draft" exists only as an explicit reopen
 * (an edit to approved work); there is no edge that changes approved work
 * while it stays approved.
 */
export const APPROVAL_TRANSITIONS: Record<ApprovalState, ApprovalState[]> = {
  draft: ['generated', 'review_required', 'approved', 'rejected', 'draft'],
  generated: ['draft', 'generated', 'review_required', 'approved', 'rejected'],
  review_required: ['approved', 'rejected', 'draft'],
  approved: [
    'scheduled',
    'ready_for_execution',
    'draft',
    'rejected',
    'executed',
  ],
  rejected: ['draft', 'generated'],
  scheduled: [
    'ready_for_execution',
    'approved',
    'draft',
    'rejected',
    'executed',
  ],
  ready_for_execution: ['executed', 'draft', 'rejected', 'approved'],
  executed: [],
};

export function canMove(from: ApprovalState, to: ApprovalState): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// The record kept on each item (aiMetadata.approval)
// ---------------------------------------------------------------------------

export interface ApprovalEvent {
  at: string;
  /** User id; null for the system (Autopilot under its auto-approve policy). */
  by: string | null;
  action: ApprovalAction;
  from: ApprovalState;
  to: ApprovalState;
  /** Content version and fingerprint after the event. */
  version: number;
  hash: string;
  reason?: string | null;
  /** For edits and regenerations: the content as it was before. */
  previous?: unknown;
  note?: string | null;
}

export interface ApprovalRecord {
  model: 1;
  /** Increments on every change to the content. */
  version: number;
  /** Fingerprint of the content now. */
  hash: string;
  approved: {
    /** The approval's id (lib/trace.ts) — what analytics and the trace refer to. */
    id?: string;
    by: string | null;
    via: 'person' | 'autopilot';
    at: string;
    version: number;
    /** What was approved — compared on every execution path. */
    hash: string;
    /** The approved content itself, kept even after it is edited later. */
    snapshot: unknown;
  } | null;
  rejected: {
    by: string | null;
    at: string;
    reason: string | null;
    version: number;
  } | null;
  events: ApprovalEvent[];
}

/** Events kept per item; older ones lose their content snapshots first. */
export const MAX_EVENTS = 60;
const SNAPSHOT_EVENTS = 15;

export function emptyRecord(hash: string): ApprovalRecord {
  return {
    model: 1,
    version: 1,
    hash,
    approved: null,
    rejected: null,
    events: [],
  };
}

export function approvalOf(meta: unknown): ApprovalRecord | null {
  const r = (meta as { approval?: ApprovalRecord } | null)?.approval;
  return r && typeof r === 'object' && r.model === 1 ? r : null;
}

/** Append an event: newest first, capped, snapshots kept only for recent changes. */
export function withEvent(
  record: ApprovalRecord,
  event: ApprovalEvent,
): ApprovalRecord {
  const events = [event, ...record.events].slice(0, MAX_EVENTS).map((e, i) => {
    if (i < SNAPSHOT_EVENTS || e.previous === undefined) return e;
    const { previous: _drop, ...rest } = e;
    void _drop;
    return rest;
  });
  return { ...record, events };
}

/** The approved content is exactly what exists now. */
export function approvalIntact(
  record: ApprovalRecord | null,
  hash: string,
): boolean {
  return Boolean(record?.approved && record.approved.hash === hash);
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x01000193;
  for (let i = str.length - 1; i >= 0; i--) {
    h2 ^= str.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** What a content approval covers: the words, the network and the images, in order. */
export function contentFingerprint(c: {
  body: unknown;
  platform: string | null;
  media: { assetId: string; altText?: string | null }[];
}): string {
  return fnv(
    JSON.stringify(
      canon({
        body: c.body ?? null,
        platform: c.platform ?? null,
        media: c.media.map((m) => [m.assetId, m.altText ?? '']),
      }),
    ),
  );
}

export function textFingerprint(text: string): string {
  return fnv(text);
}

// ---------------------------------------------------------------------------
// Each module's status as a unified state
// ---------------------------------------------------------------------------

const PEOPLE_ACTIONS: ApprovalAction[] = [
  'edited',
  'reopened',
  'changes_requested',
  'media_changed',
  'retargeted',
];

/** Untouched since Aura made it — "Generated"; once a person changes it — "Draft". */
function draftOrGenerated(record: ApprovalRecord | null): ApprovalState {
  const last = record?.events.find((e) => e.action !== 'submitted');
  return last && PEOPLE_ACTIONS.includes(last.action) ? 'draft' : 'generated';
}

export function contentState(
  d: {
    status: string;
    scheduledFor: Date | string | null;
    publishedAt?: Date | string | null;
  },
  record: ApprovalRecord | null,
  now: Date = new Date(),
): ApprovalState {
  switch (d.status) {
    case 'DRAFT':
      return draftOrGenerated(record);
    case 'PENDING_APPROVAL':
      return 'review_required';
    case 'REJECTED':
      return 'rejected';
    case 'PUBLISHED':
      return 'executed';
    case 'APPROVED': {
      if (!d.scheduledFor) return 'approved';
      return new Date(d.scheduledFor).getTime() > now.getTime()
        ? 'scheduled'
        : 'ready_for_execution';
    }
    default:
      return 'draft';
  }
}

/** Approved outreach goes straight to the extension queue — ready to send. */
export function outreachState(
  m: { status: string },
  record: ApprovalRecord | null,
): ApprovalState {
  switch (m.status) {
    case 'DRAFT':
      return draftOrGenerated(record);
    case 'PENDING_APPROVAL':
      return 'review_required';
    case 'APPROVED':
      return 'ready_for_execution';
    case 'REJECTED':
      return 'rejected';
    case 'SENT':
      return 'executed';
    default:
      return 'draft';
  }
}

/** A campaign task follows the content made for it; before that it is planned. */
export function campaignTaskState(
  t: { status: string },
  draftState: ApprovalState | null,
): ApprovalState {
  if (draftState) return draftState;
  if (t.status === 'SKIPPED') return 'rejected';
  return 'draft';
}

export interface ApprovalSummary {
  state: ApprovalState;
  label: string;
  version: number;
  approvedBy: string | null;
  approvedVia: 'person' | 'autopilot' | null;
  approvedAt: string | null;
  approvedVersion: number | null;
  /** Approved, and the content is exactly what was approved. */
  intact: boolean | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  edits: number;
  regenerations: number;
}

export function summarize(
  state: ApprovalState,
  record: ApprovalRecord | null,
  hash: string,
): ApprovalSummary {
  const approvedNow =
    state === 'approved' ||
    state === 'scheduled' ||
    state === 'ready_for_execution' ||
    state === 'executed';
  return {
    state,
    label: APPROVAL_STATE_LABEL[state],
    version: record?.version ?? 1,
    approvedBy: record?.approved?.by ?? null,
    approvedVia: record?.approved?.via ?? null,
    approvedAt: record?.approved?.at ?? null,
    approvedVersion: record?.approved?.version ?? null,
    intact: approvedNow ? approvalIntact(record, hash) : null,
    rejectedBy: record?.rejected?.by ?? null,
    rejectedAt: record?.rejected?.at ?? null,
    rejectionReason: record?.rejected?.reason ?? null,
    edits: record?.events.filter((e) => e.action === 'edited').length ?? 0,
    regenerations:
      record?.events.filter((e) => e.action === 'regenerated').length ?? 0,
  };
}

export const ACTION_LABEL: Record<ApprovalAction, string> = {
  generated: 'Generated',
  edited: 'Edited',
  regenerated: 'Regenerated',
  submitted: 'Submitted for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes requested',
  reopened: 'Reopened for changes',
  scheduled: 'Scheduled',
  unscheduled: 'Unscheduled',
  media_changed: 'Image changed',
  retargeted: 'Network changed',
  executed: 'Published / sent',
};
