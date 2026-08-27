import { requireActiveCompany } from '@/lib/auth-helpers';
import { preflightConnector } from '@/server/connectors/preflight';
import { oauthRedirectPaths } from '@/server/connectors/providers';
import { absoluteUrl, getAppUrl } from '@/lib/app-url';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/connectors/preflight?id=ga4 — is this connector actually connectable
 * from THIS deployment, and what exactly must be registered with the provider?
 *
 * Called before the browser follows an authorize URL, so a misconfiguration
 * surfaces as our message with the fix in it, rather than as the provider's
 * `Error 400: redirect_uri_mismatch` on a page we do not control.
 *
 * With no `id`, returns every redirect URI this deployment expects — the
 * copy-paste list for setting up the OAuth clients in the first place.
 */
export async function GET(req: Request) {
  try {
    await requireActiveCompany();
    const id = new URL(req.url).searchParams.get('id');

    if (!id) {
      return jsonOk({
        appUrl: getAppUrl(),
        redirectUris: oauthRedirectPaths().map((entry) => ({
          ...entry,
          uri: absoluteUrl(entry.path),
        })),
      });
    }

    const result = preflightConnector(id);
    if (!result.connectorId) return jsonError('Unknown connector.', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
