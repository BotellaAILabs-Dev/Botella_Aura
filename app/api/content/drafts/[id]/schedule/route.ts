import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { scheduleDraft } from '@/server/content/content.service';
import { resolveSchedule, scheduleInputSchema } from '@/server/scheduling/schedule-input';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/drafts/:id/schedule — schedule an APPROVED draft.
 *
 * Body: { localTime: "2026-11-02T09:00" } in the workspace's timezone (or with
 * `timeZone`), or { scheduledFor } as an exact ISO instant. Past, too-soon and
 * too-far times are refused; a daylight-saving gap/overlap is resolved and
 * explained in `note`.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:publish')) {
      return jsonError('You are not permitted to schedule publishing.', 403);
    }
    const when = await resolveSchedule(company.id, scheduleInputSchema.parse(await req.json()));
    const draft = await scheduleDraft({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      scheduledFor: when.at,
      timeZone: when.timeZone,
      local: when.local,
    });
    return jsonOk({ id: draft.id, scheduledFor: draft.scheduledFor, timeZone: when.timeZone, local: when.local, note: when.note });
  } catch (error) {
    return handleRouteError(error);
  }
}
