import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getAppUrl } from '@/lib/app-url';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { oauthRedirectUris } from '@/server/oauth/endpoints';
import { checkRedirects } from '@/server/oauth/redirect-check';

export const dynamic = 'force-dynamic';

/**
 * GET /api/connectors/oauth-check — asks LinkedIn, Google and Meta whether
 * they would accept this deployment's sign-in and connect requests
 * (server/oauth/redirect-check.ts). Sends only public client ids. Admins only:
 * it is a setup tool, and it calls out to the providers.
 */
export async function GET() {
  try {
    const { membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can run this check.', 403);
    const entries = oauthRedirectUris(getAppUrl()).filter((e) => /LINKEDIN|GOOGLE|META/.test(e.credentials.join(' ')));
    return jsonOk({ appUrl: getAppUrl(), checkedAt: new Date().toISOString(), results: await checkRedirects(entries) });
  } catch (error) {
    return handleRouteError(error);
  }
}
