import { db } from '@/lib/db';
import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getPublishContext } from '@/server/services/linkedin.service';
import {
  assertPublishable,
  DraftNotFoundError,
  getDraft,
  markPublished,
} from '@/server/content/content.service';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Publishing. HONESTY FIRST (NON-NEGOTIABLE / product principle): we only claim
 * "published" when a real official-API post succeeds. Everything else routes to
 * an explicit "copy for manual posting" fallback — never a fake published state.
 *
 * >>> LinkedIn API reality <<<
 * Auto-publishing to a Company Page requires LinkedIn's **Community Management
 * API** — product approval + the `w_organization_social` scope + an
 * organization URN (`LINKEDIN_ORG_URN`, urn:li:organization:XXXX) the connected
 * user administers. Sprint 2 connected via self-serve OIDC (`openid profile
 * email`), which CANNOT post. So until that approval lands, this returns the
 * manual fallback for every type. The real API call below is wired and will run
 * the moment scope + org URN are present.
 */
const ORG_POSTING_SCOPE = 'w_organization_social'; // Company Page (needs approval)
const MEMBER_POSTING_SCOPE = 'w_member_social'; // personal profile (self-serve "Share on LinkedIn")
// LinkedIn versions the /rest/posts endpoint (YYYYMM) and rejects out-of-window
// versions with HTTP 426. Override via LINKEDIN_API_VERSION when this ages out.
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || '202503';

export type PublishResult =
  | { mode: 'published'; url: string | null }
  | { mode: 'manual'; text: string; reason: string }
  | { mode: 'reconnect'; message: string };

/** Which types can auto-publish through an official API at all. */
export function canAutoPublish(type: ContentTypeKey): boolean {
  return type === 'LINKEDIN_POST';
}

interface PublishArgs {
  companyId: string;
  /** Null for the system-triggered scheduled job. */
  userId: string | null;
  draftId: string;
}

export async function publishDraft({
  companyId,
  userId,
  draftId,
}: PublishArgs): Promise<PublishResult> {
  const draft = await getDraft(companyId, draftId);
  if (!draft) throw new DraftNotFoundError();
  assertPublishable(draft); // hard gate — must be APPROVED

  const type = draft.type as ContentTypeKey;

  if (!canAutoPublish(type)) {
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        'Carousels, threads, and blogs can’t be auto-published through LinkedIn’s ' +
        'API — only single LinkedIn posts can. The formatted text is copied; paste ' +
        'it into a new LinkedIn post (or use the extension). Tip: generate a ' +
        '“LinkedIn post” type for one-click API publishing.',
    };
  }

  const ctx = await getPublishContext(companyId);
  if (!ctx) {
    return {
      mode: 'reconnect',
      message:
        "LinkedIn isn't connected, or the session expired. Reconnect it in " +
        'Settings → Connections to publish.',
    };
  }

  const commentary = renderLinkedInCommentary(draft);
  if (!commentary) {
    return { mode: 'manual', text: renderForManual(draft), reason: 'Draft body was invalid.' };
  }
  const scopes = (ctx.scope ?? '').split(/[\s,]+/);

  // 1) Company Page — if Community Management approval + org URN are present.
  const orgUrn = process.env.LINKEDIN_ORG_URN;
  if (scopes.includes(ORG_POSTING_SCOPE) && orgUrn) {
    const url = await postToLinkedIn(ctx.token, orgUrn, commentary);
    await markPublished({ companyId, userId, draftId, publishedUrl: url });
    return { mode: 'published', url };
  }

  // 2) Personal profile — the self-serve "Share on LinkedIn" (w_member_social)
  //    path. Publishes the APPROVED post to the connected member's own feed.
  if (scopes.includes(MEMBER_POSTING_SCOPE) && ctx.linkedInUserId) {
    const author = `urn:li:person:${ctx.linkedInUserId}`;
    const url = await postToLinkedIn(ctx.token, author, commentary);
    await markPublished({ companyId, userId, draftId, publishedUrl: url });
    return { mode: 'published', url };
  }

  // 3) No posting scope granted → manual / extension fallback.
  return {
    mode: 'manual',
    text: renderForManual(draft),
    reason:
      "LinkedIn is connected but wasn't granted posting permission. Reconnect and " +
      'approve "Share on LinkedIn", or post via the extension. (Company Page ' +
      'publishing additionally needs Marketing API approval.)',
  };
}

/**
 * POST to LinkedIn via the official /rest/posts endpoint. `authorUrn` is either
 * an organization URN (Company Page) or a person URN (personal profile). Throws
 * on failure so the caller keeps the draft APPROVED for retry.
 */
async function postToLinkedIn(
  token: string,
  authorUrn: string,
  commentary: string,
): Promise<string | null> {
  const res = await httpRequest('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'linkedin-version': LINKEDIN_API_VERSION,
      'x-restli-protocol-version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    timeoutMs: 12_000,
    retries: 0,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error('LinkedIn publish failed', { status: res.status, detail: detail.slice(0, 300) });
    throw Object.assign(
      new Error(`LinkedIn publish failed (${res.status}).`),
      { status: 502 },
    );
  }
  const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  return urn ? `https://www.linkedin.com/feed/update/${urn}` : null;
}

/**
 * Scheduled-publish job. Processes APPROVED drafts whose `scheduledFor` is due.
 * Idempotent: a successful publish flips status to PUBLISHED so it's never
 * picked again; drafts that can't auto-publish (wrong type / pending LinkedIn
 * approval) are counted as skipped and left as calendar markers.
 */
export async function runScheduledPublishes(now: Date = new Date()): Promise<{
  attempted: number;
  published: number;
  skipped: number;
}> {
  const due = await db.contentDraft.findMany({
    where: {
      status: 'APPROVED',
      scheduledFor: { lte: now },
      publishedAt: null,
    },
    select: { id: true, companyId: true },
    take: 200,
  });

  let published = 0;
  let skipped = 0;
  for (const d of due) {
    try {
      const result = await publishDraft({
        companyId: d.companyId,
        userId: null, // system-triggered; audit userId null
        draftId: d.id,
      });
      if (result.mode === 'published') published++;
      else skipped++;
    } catch (err) {
      skipped++;
      logger.error('scheduled publish failed', {
        draftId: d.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attempted: due.length, published, skipped };
}
