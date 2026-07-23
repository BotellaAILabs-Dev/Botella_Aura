import { requireActiveCompany } from '@/lib/auth-helpers';
import { getCompanyById } from '@/server/services/company.service';
import { resyncCompany } from '@/server/knowledge/ingest.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** POST /api/knowledge/sync — (re)ingest the active company's website + blog. */
export async function POST() {
  try {
    const { company } = await requireActiveCompany();
    const full = await getCompanyById(company.id);
    if (!full?.website) {
      return jsonError('Add a company website in Settings first.', 400);
    }
    const result = await resyncCompany({ id: full.id, website: full.website });
    return jsonOk({ chunks: result.chunks });
  } catch (error) {
    return handleRouteError(error);
  }
}
