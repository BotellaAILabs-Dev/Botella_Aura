import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { createCompetitorSchema } from '@/lib/validations/competitors';
import {
  addCompetitor,
  listCompetitors,
} from '@/server/competitors/competitor.service';
import {
  getRequestMeta,
  handleRouteError,
  jsonError,
  jsonOk,
} from '@/lib/api';

/** GET /api/competitors — list competitors (any member). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const competitors = await listCompetitors(company.id);
    return jsonOk({ competitors });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/competitors — add a competitor (OWNER/ADMIN). */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage competitors.', 403);
    }
    const input = createCompetitorSchema.parse(await req.json());
    const competitor = await addCompetitor({
      companyId: company.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ id: competitor.id, name: competitor.name }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
