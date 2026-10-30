import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { websiteOptions } from '@/server/websites/connection.service';

/** GET /api/websites/:id/options — live categories, authors, blogs and recent posts. */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk(await websiteOptions(company.id, params.id));
  } catch (error) {
    return handleRouteError(error);
  }
}
