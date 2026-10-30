import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { previewForWebsite, publishOptionsSchema } from '@/server/websites/publish.service';

/**
 * POST /api/content/drafts/:id/website-publish/preview { websiteId, options? }
 * The exact HTML that website would receive with these options. Read-only.
 */
export const dynamic = 'force-dynamic';

const schema = z.object({ websiteId: z.string().min(1), options: publishOptionsSchema.optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const input = schema.parse(await req.json());
    return jsonOk(await previewForWebsite(company.id, params.id, input.websiteId, input.options));
  } catch (error) {
    return handleRouteError(error);
  }
}
