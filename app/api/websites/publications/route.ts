import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { listWebsitePublications } from '@/server/websites/publish.service';

/** GET /api/websites/publications?websiteId=&draftId= — the publishing history. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const url = new URL(req.url);
    const publications = await listWebsitePublications(company.id, {
      websiteId: url.searchParams.get('websiteId') ?? undefined,
      draftId: url.searchParams.get('draftId') ?? undefined,
    });
    return jsonOk({ publications });
  } catch (error) {
    return handleRouteError(error);
  }
}
