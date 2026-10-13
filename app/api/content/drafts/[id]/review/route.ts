import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { isReviewCurrent } from '@/lib/content-review';
import { getDraft } from '@/server/content/content.service';
import { reviewDraft, storedReview } from '@/server/content/review.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * The AI Reviewer for one draft (lib/content-review.ts).
 *
 *   GET  — the stored review, and whether it still describes the draft
 *   POST — review the draft as it stands now, and store the result
 *
 * Reviewing never changes the draft's content or status.
 */
export const maxDuration = 60;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    const review = storedReview(draft);
    return jsonOk({ review, current: isReviewCurrent(review, draft.body) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot run a review.', 403);
    }
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('Published content is not reviewed again.', 409);
    }
    const { review } = await reviewDraft(draft, { trigger: 'manual' });
    return jsonOk({ review, current: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
