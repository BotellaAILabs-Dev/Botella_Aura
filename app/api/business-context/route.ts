import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { businessContextUpdateSchema } from '@/lib/validations/business-context';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';

/**
 * The Business Context over HTTP, scoped to the caller's active workspace.
 *
 * GET   — the resolved context: every field, where each value came from, which
 *         values conflicted, what is missing, and `meta.revision`.
 * PATCH — `{ patch, expectedRevision? }`. Validated by the patch schema and
 *         the update rules; 422 names each refused field, 409 means the
 *         workspace changed since `expectedRevision` was read.
 *
 * No knowledge retrieval here (that needs a query and belongs to the workflow
 * asking), so `knowledge.passages` is always empty.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const context = await getBusinessContext(company.id);
    if (!context) return jsonError('Company not found', 404);
    return jsonOk({ context });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can change business information.',
        403,
      );
    }

    const body = businessContextUpdateSchema.parse(await req.json());
    const { changed, confirmed } = await updateBusinessContext({
      companyId: company.id,
      userId: user.id,
      patch: body.patch,
      origin: 'api',
      expectedRevision: body.expectedRevision,
      confirm: body.confirm,
      requestMeta: getRequestMeta(req),
    });

    const context = await getBusinessContext(company.id);
    return jsonOk({ changed, confirmed, context });
  } catch (error) {
    return handleRouteError(error);
  }
}
