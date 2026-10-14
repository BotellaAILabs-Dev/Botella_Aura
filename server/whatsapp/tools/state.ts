import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';

/**
 * Conversation context for a linked WhatsApp session (WhatsAppAccountLink.state):
 *
 *   draftId    the draft "this post" refers to in a follow-up
 *   assetId    the image just generated, for "use this image"
 *   pending    an action waiting for an explicit yes (approve, reject) —
 *              single use, expires, tied to one draft
 *   inFlight   slow work started for one message, so a retried job does not
 *              start (and pay for) it again
 *
 * The state records the workspace it belongs to and is IGNORED when that is
 * not the active workspace — after switching, nothing from the other
 * business carries over. Writes need no locking: one conversation's messages
 * are handled one at a time (server/whatsapp/queue.ts).
 */

export interface PendingAction {
  nonce: string;
  action: 'approve' | 'reject' | 'publish';
  draftId: string;
  /** For 'publish': exactly the networks the person was asked to confirm. */
  platforms?: string[];
  /** Approve again with the person vouching for the flagged claims/review. */
  acknowledged?: boolean;
  expiresAt: string;
}

export interface SessionState {
  companyId?: string;
  draftId?: string;
  assetId?: string;
  pending?: PendingAction;
  inFlight?: { messageId: string; tool: string; startedAt: string };
  /**
   * The next message answers a question we asked: a topic for a new post
   * ("Write a post" tapped), or what to change in a draft ("Edit" tapped).
   */
  awaiting?: {
    /** topic / edit (Phase 4); platforms: which networks for a social post;
     *  social_topic: what the social post is about. */
    kind: 'topic' | 'edit' | 'platforms' | 'social_topic';
    draftId?: string;
    topic?: string;
    platforms?: string[];
    expiresAt: string;
  };
  /** The networks the current draft is meant for (a social post). */
  targets?: string[];
}

/** How long a pending confirmation waits for its yes. */
export const PENDING_TTL_MS = 10 * 60_000;

export async function readState(linkId: string, companyId: string): Promise<SessionState> {
  const link = await db.whatsAppAccountLink.findUnique({ where: { id: linkId }, select: { state: true } });
  const s = (link?.state ?? {}) as SessionState;
  return s.companyId === companyId ? s : {};
}

/** Merge into the state for this workspace (undefined clears a key). */
export async function writeState(linkId: string, companyId: string, patch: Partial<SessionState>): Promise<SessionState> {
  const current = await readState(linkId, companyId);
  const next: SessionState = { ...current, ...patch, companyId };
  for (const k of Object.keys(next) as (keyof SessionState)[]) {
    if (next[k] === undefined) delete next[k];
  }
  await db.whatsAppAccountLink.update({
    where: { id: linkId },
    data: { state: next as unknown as Prisma.InputJsonObject },
  });
  return next;
}

export function newPending(
  action: PendingAction['action'],
  draftId: string,
  acknowledged = false,
  platforms?: string[],
): PendingAction {
  return {
    nonce: crypto.randomBytes(9).toString('base64url'),
    action,
    draftId,
    ...(platforms ? { platforms } : {}),
    ...(acknowledged ? { acknowledged } : {}),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
}
