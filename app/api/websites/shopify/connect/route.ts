import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { bindingCookieOptions } from '@/lib/pkce';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { shopifyAuthorizeUrl } from '@/server/websites/shopify-oauth';
import { WebsitePublishError } from '@/server/websites/types';

/**
 * POST /api/websites/shopify/connect { shop } — start Shopify OAuth. Returns
 * the store's consent URL for the browser to follow, and sets the cookie that
 * binds the flow to this browser (checked at /api/websites/shopify/callback).
 */
export const dynamic = 'force-dynamic';

const schema = z.object({ shop: z.string().trim().min(1).max(200) });

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can connect websites.', 403);
    const { shop } = schema.parse(await req.json());
    let start;
    try {
      start = shopifyAuthorizeUrl({ shop, companyId: company.id, userId: user.id });
    } catch (err) {
      if (err instanceof WebsitePublishError) return jsonError(err.message, 409);
      throw err;
    }
    const res = jsonOk({ authorizeUrl: start.url });
    res.cookies.set(start.cookie.name, start.cookie.value, bindingCookieOptions);
    return res;
  } catch (error) {
    return handleRouteError(error);
  }
}
