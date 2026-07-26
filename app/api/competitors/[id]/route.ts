import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { updateCompetitorSchema } from '@/lib/validations/competitors';
import {
  removeCompetitor,
  updateCompetitor,
} from '@/server/competitors/competitor.service';
import {
  getRequestMeta,
  handleRouteError,
  jsonError,
  jsonOk,
} from '@/lib/api';

/** PATCH /api/competitors/:id — update a competitor (OWNER/ADMIN). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage competitors.', 403);
    }
    const input = updateCompetitorSchema.parse(await req.json());
    const competitor = await updateCompetitor({
      companyId: company.id,
      userId: user.id,
      competitorId: params.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: competitor.id, name: competitor.name });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/competitors/:id — remove a competitor (OWNER/ADMIN). */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage competitors.', 403);
    }
    await removeCompetitor({
      companyId: company.id,
      userId: user.id,
      competitorId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
