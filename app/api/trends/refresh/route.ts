import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { recordAudit } from '@/server/services/audit.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { logger } from '@/lib/logger';
import type { DigestPayload } from '@/server/trends/types';

/**
 * POST /api/trends/refresh — manual "Refresh digest" trigger for the active
 * company. Same idempotent generation as the cron job, scoped to one company.
 *
 * Generation fans out to every configured source and makes two model calls, so
 * it regularly runs past the platform's default 10-15s function budget. Without
 * the longer budget below, the request was killed mid-flight and the UI showed a
 * bare "Something went wrong" — the exact symptom reported in review. Every
 * other long-running route in the app already declares this.
 */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active company', 400);

    const membership = await getMembership(user.id, active.id);
    if (!membership) return jsonError('Forbidden', 403);

    await recordAudit({
      action: 'TREND_DIGEST_REQUESTED',
      userId: user.id,
      companyId: active.id,
      metadata: { trigger: 'manual' },
      ...getRequestMeta(req),
    });

    const digest = await generateDigestForCompany({
      companyId: active.id,
      userId: user.id,
      trigger: 'manual',
    });

    const payload = digest.payload as unknown as DigestPayload;
    return jsonOk({
      id: digest.id,
      date: digest.date,
      itemCount: payload.items?.length ?? 0,
      model: payload.model,
      skippedSources: payload.skippedSources ?? [],
    });
  } catch (error) {
    // Digest generation touches many third-party sources; a generic 500 leaves
    // the user with no idea what to fix. Surface the real reason.
    logger.error('trends/refresh: digest generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && !('status' in error)) {
      return jsonError(
        `We couldn't refresh your digest: ${error.message}. Your previous digest is unchanged — check your sources in trend settings and try again.`,
        502,
      );
    }
    return handleRouteError(error);
  }
}
