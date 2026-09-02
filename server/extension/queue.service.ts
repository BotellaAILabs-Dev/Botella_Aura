import { db } from '@/lib/db';
import { renderForManual } from '@/server/content/render';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { resolvePlatform, platformSpec } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * The Action Queue the Chrome Extension reads (Sprint 4, Module 2).
 *
 * The backend only HANDS the human ready-to-send text — it never touches
 * LinkedIn. Each item carries the exact text to inject into LinkedIn's own
 * compose/comment/message box, and a stable itemType+itemId the extension posts
 * back to /api/extension/actions/complete after the human clicks send.
 *
 * Items now also carry their MEDIA as metadata — ids and dimensions, never
 * bytes. A queue listing is fetched every time the panel opens, so inlining
 * images would make it tens of megabytes; the extension fetches each image
 * separately, and only when the human actually acts on that item.
 */
export type QueueItemType =
  | 'content_draft'
  | 'outreach_message'
  | 'engagement_comment';

export type InjectTarget =
  | 'linkedin_compose'
  | 'linkedin_comment'
  | 'linkedin_message';

/** One image attached to a queue item. Bytes come from /api/extension/media/:id. */
export interface QueueItemMedia {
  assetId: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
  altText?: string;
}

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
  /** Where this post is aimed, so the panel can label it. */
  platform?: string;
  platformLabel?: string;
  /** Attached graphics, in order. Empty for text-only items. */
  media: QueueItemMedia[];
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
    // One query for drafts and their media rather than N+1 lookups: the panel
    // opens on every LinkedIn page load, so this path stays cheap.
    include: {
      media: {
        orderBy: { position: 'asc' },
        include: {
          asset: {
            select: {
              id: true,
              mimeType: true,
              width: true,
              height: true,
              fileSize: true,
            },
          },
        },
      },
    },
  });

  for (const d of drafts) {
    const text = renderForManual(d);
    if (!text) continue;
    const type = d.type as ContentTypeKey;
    const platform = resolvePlatform(type, d.platform);

    items.push({
      id: `content_draft:${d.id}`,
      itemType: 'content_draft',
      itemId: d.id,
      title: d.title ?? CONTENT_TYPE_LABELS[type] ?? 'Post',
      subtitle: CONTENT_TYPE_LABELS[type],
      text,
      target: 'linkedin_compose',
      platform,
      platformLabel: platformSpec(platform).label,
      media: d.media.map((m) => ({
        assetId: m.assetId,
        mimeType: m.asset.mimeType,
        width: m.asset.width,
        height: m.asset.height,
        fileSize: m.asset.fileSize,
        ...(m.altText ? { altText: m.altText } : {}),
      })),
      createdAt: d.updatedAt.toISOString(),
    });
  }

  // --- Approved outreach messages awaiting a human send (Module 3) ---
  const messages = await db.outreachMessage.findMany({
    where: { companyId, status: 'APPROVED' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { lead: true },
  });
  for (const m of messages) {
    const who = m.lead.name
      ? `${m.lead.name} (${m.lead.companyName})`
      : m.lead.companyName;
    items.push({
      id: `outreach_message:${m.id}`,
      itemType: 'outreach_message',
      itemId: m.id,
      title:
        m.type === 'CONNECTION_NOTE'
          ? `Connection note → ${who}`
          : `Follow-up → ${who}`,
      subtitle: m.type === 'CONNECTION_NOTE' ? 'Connection note' : 'Follow-up',
      text: m.draftText,
      target: 'linkedin_message',
      contextUrl: m.lead.linkedInProfileUrl ?? undefined,
      // Outreach messages carry no media; the field stays present so the
      // extension never has to check whether the key exists.
      media: [],
      createdAt: m.updatedAt.toISOString(),
    });
  }

  // Engagement (Module 4) items are appended here once that module lands.

  return items;
}
