import { db } from '@/lib/db';
import { renderForManual } from '@/server/content/render';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * The Action Queue the Chrome Extension reads (Sprint 4, Module 2).
 *
 * The backend only HANDS the human ready-to-send text — it never touches
 * LinkedIn. Each item carries the exact text to inject into LinkedIn's own
 * compose/comment/message box, and a stable itemType+itemId the extension posts
 * back to /api/extension/actions/complete after the human clicks send.
 *
 * Module 2 populates the queue from APPROVED Content Studio drafts (the manual-
 * publish fallback for personal-profile posts). Outreach messages (Module 3)
 * and engagement comments (Module 4) extend `QueueItemType` + getQueue.
 */
export type QueueItemType =
  | 'content_draft'
  | 'outreach_message'
  | 'engagement_comment';

export type InjectTarget =
  | 'linkedin_compose'
  | 'linkedin_comment'
  | 'linkedin_message';

export interface QueueItem {
  /** Stable composite id for the extension list. */
  id: string;
  itemType: QueueItemType;
  itemId: string;
  title: string;
  subtitle?: string;
  /** The exact, human-reviewed text to inject. */
  text: string;
  target: InjectTarget;
  /** Optional URL the human should be on to perform the action. */
  contextUrl?: string;
  createdAt: string;
}

/** Build the pending action queue for a company. */
export async function getQueue(companyId: string): Promise<QueueItem[]> {
  const items: QueueItem[] = [];

  // --- Approved content drafts awaiting manual publish ---
  const drafts = await db.contentDraft.findMany({
    where: { companyId, status: 'APPROVED' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  for (const d of drafts) {
    const text = renderForManual(d);
    if (!text) continue;
    items.push({
      id: `content_draft:${d.id}`,
      itemType: 'content_draft',
      itemId: d.id,
      title: d.title ?? CONTENT_TYPE_LABELS[d.type as ContentTypeKey] ?? 'Post',
      subtitle: CONTENT_TYPE_LABELS[d.type as ContentTypeKey],
      text,
      target: 'linkedin_compose',
      createdAt: d.updatedAt.toISOString(),
    });
  }

  // Outreach (Module 3) and Engagement (Module 4) items are appended here once
  // those modules land — the extension already renders any QueueItem shape.

  return items;
}
