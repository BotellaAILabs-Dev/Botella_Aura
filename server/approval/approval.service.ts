import type { ContentDraft, OutreachMessage, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  approvalIntact,
  approvalOf,
  contentFingerprint,
  contentState,
  emptyRecord,
  outreachState,
  textFingerprint,
  withEvent,
  type ApprovalAction,
  type ApprovalRecord,
  type ApprovalState,
} from '@/lib/approval';

/**
 * Applies the unified approval model (lib/approval.ts) to stored items.
 *
 * The record lives in each item's aiMetadata.approval, next to the content it
 * describes, and every change to it is also an audit entry (made by the
 * module services). Records are created lazily, so items that existed before
 * this model get one the first time they are touched.
 */

type Db = Prisma.TransactionClient | typeof db;
type Meta = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Content Studio drafts
// ---------------------------------------------------------------------------

export async function contentMedia(draftId: string, client: Db = db) {
  return client.contentMedia.findMany({
    where: { contentDraftId: draftId },
    orderBy: { position: 'asc' },
    select: { assetId: true, altText: true },
  });
}

/** The fingerprint of what this draft would publish now. */
export async function contentHash(
  draft: Pick<ContentDraft, 'id' | 'body' | 'platform'>,
  client: Db = db,
): Promise<string> {
  return contentFingerprint({
    body: draft.body,
    platform: draft.platform,
    media: await contentMedia(draft.id, client),
  });
}

/**
 * The draft's record, created if it has none. A draft approved before
 * records existed is recorded as approved as it stands, by an unknown approver.
 */
export function contentRecord(
  draft: Pick<
    ContentDraft,
    'aiMetadata' | 'status' | 'body' | 'platform' | 'updatedAt'
  >,
  hash: string,
): ApprovalRecord {
  const existing = approvalOf(draft.aiMetadata);
  if (existing) return existing;
  const r = emptyRecord(hash);
  if (draft.status === 'APPROVED' || draft.status === 'PUBLISHED') {
    r.approved = {
      by: null,
      via: 'person',
      at: draft.updatedAt.toISOString(),
      version: 1,
      hash,
      snapshot: { body: draft.body, platform: draft.platform },
    };
  }
  return r;
}

export interface ContentEventArgs {
  action: ApprovalAction;
  by: string | null;
  /** The status the draft will have after the change. */
  nextStatus: ContentDraft['status'];
  nextScheduledFor?: Date | null;
  /** The fingerprint after the change (defaults to the current one). */
  nextHash: string;
  /** Content changed: bump the version and keep the previous content. */
  previous?: unknown;
  reason?: string | null;
  note?: string | null;
  approve?: { via: 'person' | 'autopilot'; snapshot: unknown };
}

/**
 * The aiMetadata to write with a change: the record with the event appended
 * and, for an approval or rejection, who and when.
 */
export function contentMetaAfter(
  draft: Pick<
    ContentDraft,
    'aiMetadata' | 'status' | 'body' | 'platform' | 'updatedAt' | 'scheduledFor'
  >,
  currentHash: string,
  e: ContentEventArgs,
): Prisma.InputJsonValue {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  let r = contentRecord(draft, currentHash);
  const from = contentState(draft, r);
  const changed = e.previous !== undefined || e.nextHash !== r.hash;
  const version = changed ? r.version + 1 : r.version;
  const at = new Date().toISOString();
  r = { ...r, version, hash: e.nextHash };
  if (e.approve) {
    r.approved = {
      by: e.by,
      via: e.approve.via,
      at,
      version,
      hash: e.nextHash,
      snapshot: e.approve.snapshot,
    };
    r.rejected = null;
  }
  if (e.action === 'rejected')
    r.rejected = { by: e.by, at, reason: e.reason ?? null, version };
  const to = contentState(
    {
      status: e.nextStatus,
      scheduledFor:
        e.nextScheduledFor === undefined
          ? draft.scheduledFor
          : e.nextScheduledFor,
    },
    { ...r, events: [{ action: e.action } as never, ...r.events] },
  );
  r = withEvent(r, {
    at,
    by: e.by,
    action: e.action,
    from,
    to,
    version,
    hash: e.nextHash,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.previous !== undefined ? { previous: e.previous } : {}),
    ...(e.note ? { note: e.note } : {}),
  });
  return { ...meta, approval: r } as unknown as Prisma.InputJsonValue;
}

export class ApprovalIntegrityError extends Error {
  readonly status = 409;
  readonly code = 'changed_after_approval';
  constructor() {
    super(
      'This content changed after it was approved. It must be approved again before it can be scheduled or published.',
    );
    this.name = 'ApprovalIntegrityError';
  }
}

/** Throws unless the draft is exactly what was approved. Every execution path calls it. */
export async function assertContentIntact(
  draft: ContentDraft,
  client: Db = db,
): Promise<void> {
  const hash = await contentHash(draft, client);
  const r = contentRecord(draft, hash);
  if (!approvalIntact(r, hash)) throw new ApprovalIntegrityError();
}

/** A campaign task follows its content's approval (it was never approved before). */
export async function syncCampaignTask(
  draftId: string,
  status: ContentDraft['status'],
  client: Db = db,
) {
  if (status === 'APPROVED' || status === 'PUBLISHED') {
    await client.campaignTask.updateMany({
      where: { relatedContentDraftId: draftId, status: 'GENERATED' },
      data: { status: 'APPROVED' },
    });
  } else {
    await client.campaignTask.updateMany({
      where: { relatedContentDraftId: draftId, status: 'APPROVED' },
      data: { status: 'GENERATED' },
    });
  }
}

/**
 * Record a change that does not go through the status machine (an image
 * swapped, the network changed): approved work is reopened, never changed
 * in place.
 */
export async function recordContentChange(args: {
  draftId: string;
  companyId: string;
  by: string | null;
  action: 'media_changed' | 'retargeted';
  /** Applied in the same transaction, before the new fingerprint is taken. */
  apply: (tx: Prisma.TransactionClient) => Promise<void>;
  previous?: unknown;
}): Promise<{ reopened: boolean }> {
  return db.$transaction(async (tx) => {
    const draft = await tx.contentDraft.findFirst({
      where: { id: args.draftId, companyId: args.companyId },
    });
    if (!draft)
      throw Object.assign(new Error('Draft not found.'), { status: 404 });
    const before = await contentHash(draft, tx);
    // Make sure the record exists BEFORE the change, so a legacy approval is
    // recorded against what was actually approved.
    const base = {
      ...draft,
      aiMetadata: {
        ...((draft.aiMetadata ?? {}) as Meta),
        approval: contentRecord(draft, before),
      } as unknown as Prisma.JsonValue,
    };
    await args.apply(tx);
    const after = await tx.contentDraft.findUniqueOrThrow({
      where: { id: draft.id },
    });
    const hash = await contentHash(after, tx);
    if (hash === before) return { reopened: false };
    const reopen =
      draft.status === 'APPROVED' || draft.status === 'PENDING_APPROVAL';
    const nextStatus = reopen ? 'DRAFT' : draft.status;
    await tx.contentDraft.update({
      where: { id: draft.id },
      data: {
        status: nextStatus,
        aiMetadata: contentMetaAfter(
          { ...base, platform: after.platform },
          before,
          {
            action: args.action,
            by: args.by,
            nextStatus,
            nextHash: hash,
            previous: args.previous ?? null,
            note: reopen
              ? 'Changed after it was approved or submitted — it needs approving again.'
              : null,
          },
        ),
      },
    });
    if (reopen) await syncCampaignTask(draft.id, nextStatus, tx);
    return { reopened: reopen };
  });
}

// ---------------------------------------------------------------------------
// Outreach messages
// ---------------------------------------------------------------------------

export function outreachRecord(
  m: Pick<OutreachMessage, 'aiMetadata' | 'status' | 'draftText' | 'updatedAt'>,
): ApprovalRecord {
  const existing = approvalOf(m.aiMetadata);
  if (existing) return existing;
  const hash = textFingerprint(m.draftText);
  const r = emptyRecord(hash);
  if (m.status === 'APPROVED' || m.status === 'SENT') {
    r.approved = {
      by: null,
      via: 'person',
      at: m.updatedAt.toISOString(),
      version: 1,
      hash,
      snapshot: m.draftText,
    };
  }
  return r;
}

export function outreachMetaAfter(
  m: Pick<OutreachMessage, 'aiMetadata' | 'status' | 'draftText' | 'updatedAt'>,
  e: {
    action: ApprovalAction;
    by: string | null;
    nextStatus: OutreachMessage['status'];
    nextText?: string;
    reason?: string | null;
    approve?: boolean;
  },
): Prisma.InputJsonValue {
  const meta = (m.aiMetadata ?? {}) as Meta;
  let r = outreachRecord(m);
  const from = outreachState(m, r);
  const text = e.nextText ?? m.draftText;
  const hash = textFingerprint(text);
  const changed = hash !== r.hash;
  const version = changed ? r.version + 1 : r.version;
  const at = new Date().toISOString();
  r = { ...r, version, hash };
  if (e.approve) {
    r.approved = { by: e.by, via: 'person', at, version, hash, snapshot: text };
    r.rejected = null;
  }
  if (e.action === 'rejected')
    r.rejected = { by: e.by, at, reason: e.reason ?? null, version };
  const to: ApprovalState = outreachState(
    { status: e.nextStatus },
    { ...r, events: [{ action: e.action } as never, ...r.events] },
  );
  r = withEvent(r, {
    at,
    by: e.by,
    action: e.action,
    from,
    to,
    version,
    hash,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(changed ? { previous: m.draftText } : {}),
  });
  return { ...meta, approval: r } as unknown as Prisma.InputJsonValue;
}

export function outreachIntact(
  m: Pick<OutreachMessage, 'aiMetadata' | 'status' | 'draftText' | 'updatedAt'>,
): boolean {
  return approvalIntact(outreachRecord(m), textFingerprint(m.draftText));
}

/**
 * The aiMetadata for a change to a draft's content (an edit, a regeneration,
 * a variation, an undo): `base` is the metadata the caller is writing, the
 * approval record is moved on and the previous content kept.
 */
export async function contentChangeMeta(
  draft: ContentDraft,
  base: Meta,
  e: {
    action: 'edited' | 'regenerated';
    by: string | null;
    nextStatus: ContentDraft['status'];
    nextBody: unknown;
    nextPlatform?: ContentDraft['platform'];
    note?: string | null;
  },
): Promise<Prisma.InputJsonValue> {
  const media = await contentMedia(draft.id);
  const before = contentFingerprint({
    body: draft.body,
    platform: draft.platform,
    media,
  });
  return contentMetaAfter(
    { ...draft, aiMetadata: base as unknown as Prisma.JsonValue },
    before,
    {
      action: e.action,
      by: e.by,
      nextStatus: e.nextStatus,
      nextHash: contentFingerprint({
        body: e.nextBody,
        platform: e.nextPlatform ?? draft.platform,
        media,
      }),
      previous: draft.body,
      note:
        e.note ??
        (draft.status === 'APPROVED'
          ? 'Changed after approval — it needs approving again.'
          : null),
    },
  );
}

/** The record a newly generated draft starts with. */
export function generatedRecord(
  body: unknown,
  platform: string | null,
  by: string | null,
): ApprovalRecord {
  const hash = contentFingerprint({ body, platform, media: [] });
  return withEvent(emptyRecord(hash), {
    at: new Date().toISOString(),
    by,
    action: 'generated',
    from: 'draft',
    to: 'generated',
    version: 1,
    hash,
  });
}
