import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { WEBSITE_PLATFORMS } from '@/lib/website-platforms';
import { connectWebsite, listWebsites } from '@/server/websites/connection.service';
import { getAdapter, shopifyOAuthConfigured } from '@/server/websites/registry';

/**
 * GET  /api/websites — connected websites (no secrets) and the platforms
 *      that can be connected on this deployment.
 * POST /api/websites { platform, name?, fields } — connect a site with a
 *      form (WordPress Application Password, Ghost Admin API key, Shopify
 *      Admin API token). Shopify OAuth starts at /api/websites/shopify/connect.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const connectSchema = z.object({
  platform: z.string().min(1).max(40),
  name: z.string().trim().max(80).optional(),
  fields: z.record(z.string().max(2000)),
});

export async function GET() {
  try {
    const { company, membership } = await requireActiveCompany();
    const websites = await listWebsites(company.id);
    return jsonOk({
      websites,
      canManage: can(membership.role, 'company:update'),
      canPublish: can(membership.role, 'content:publish'),
      platforms: WEBSITE_PLATFORMS.map((p) => ({
        ...p,
        connectable: p.status === 'available' && Boolean(getAdapter(p.id)),
        ...(p.id === 'shopify' ? { oauthConfigured: shopifyOAuthConfigured() } : {}),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can connect websites.', 403);
    const input = connectSchema.parse(await req.json());
    const website = await connectWebsite({
      companyId: company.id,
      userId: user.id,
      platform: input.platform,
      name: input.name,
      // Only the OAuth callback may mark a connection as OAuth.
      input: { ...input.fields, authKind: '' },
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ website }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
