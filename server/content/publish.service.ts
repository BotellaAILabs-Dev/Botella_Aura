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
const ORG_POSTING_SCOPE = 'w_organization_social';
const LINKEDIN_API_VERSION = '202401';

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
        "This content type isn't natively publishable via LinkedIn's Company " +
        'Page API yet. Copy the formatted text and post it manually.',
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

  const orgUrn = process.env.LINKEDIN_ORG_URN;
  const hasScope = (ctx.scope ?? '')
    .split(/[\s,]+/)
    .includes(ORG_POSTING_SCOPE);

  if (!hasScope || !orgUrn) {
    return {
      mode: 'manual',
      text: renderForManual(draft),
      reason:
        'Automatic Company Page publishing needs LinkedIn Community Management ' +
        'API approval (w_organization_social scope + an organization URN). ' +
        "That's pending — copy the text and post manually for now.",
    };
  }

  // --- Real official-API publish (runs once approval + scope + org URN exist) ---
  const commentary = renderLinkedInCommentary(draft);
  if (!commentary) {
    return { mode: 'manual', text: renderForManual(draft), reason: 'Draft body was invalid.' };
  }
  const url = await postToCompanyPage(ctx.token, orgUrn, commentary);
  await markPublished({ companyId, userId, draftId, publishedUrl: url });
  return { mode: 'published', url };
}

/**
 * POST to a LinkedIn Company Page via the official /rest/posts endpoint.
 * Throws on failure so the caller keeps the draft APPROVED for retry.
 */
async function postToCompanyPage(
  token: string,
  orgUrn: string,
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
      author: orgUrn,
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
