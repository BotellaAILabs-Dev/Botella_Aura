import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { saveApiKeySchema } from '@/lib/validations/connectors';
import {
  ConnectorError,
  disconnect,
  getConnection,
  saveApiKey,
} from '@/server/connectors/connection.service';
import { getProvider, providerReadiness } from '@/server/connectors/providers';
import { buildAuthorizeUrl } from '@/server/connectors/oauth';
import { bindingCookieOptions } from '@/lib/pkce';
import { preflightConnector } from '@/server/connectors/preflight';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';
// Saving a key verifies it against the provider first.
export const maxDuration = 60;

/** GET /api/connectors/:id — status for one connector. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({
      connectorId: params.id,
      readiness: providerReadiness(params.id),
      connection: await getConnection(company.id, params.id),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/connectors/:id — connect.
 *
 * API-key connectors: the body carries the key, which is verified against the
 * provider before it is stored. OAuth connectors: returns the authorize URL for
 * the browser to follow (no body needed).
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage connectors.', 403);
    }

    const provider = getProvider(params.id);
    if (!provider) {
      return jsonError(
        `"${params.id}" is on the roadmap but does not have an integration yet.`,
        404,
      );
    }

    if (provider.auth === 'oauth') {
      const ready = providerReadiness(params.id);
      if (!ready.connectable) {
        return jsonError(ready.blockedReason ?? 'This connector is not available yet.', 409);
      }

      // Catch a misconfigured redirect here rather than letting the provider
      // reject it on a page we do not control and cannot explain.
      const preflight = preflightConnector(params.id);
      if (!preflight.ok) {
        const blocker = preflight.issues.find((i) => i.severity === 'blocker');
        return jsonError(
          blocker?.message ?? 'This connector is not configured correctly yet.',
          409,
        );
      }

      const start = buildAuthorizeUrl({
        connectorId: params.id,
        companyId: company.id,
        userId: user.id,
      });
      const res = jsonOk({
        authorizeUrl: start.url,
        // Shown alongside a failure so an admin can fix it without digging.
        redirectUri: preflight.redirectUri,
      });
      // Binds the flow to this browser (and carries the PKCE verifier).
      res.cookies.set(start.cookie.name, start.cookie.value, bindingCookieOptions);
      return res;
    }

    const input = saveApiKeySchema.parse(await req.json());
    const connection = await saveApiKey({
      companyId: company.id,
      userId: user.id,
      connectorId: params.id,
      apiKey: input.apiKey,
      metadata: input.metadata,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ connection }, 201);
  } catch (error) {
    if (error instanceof ConnectorError) {
      return jsonError(error.message, error.status);
    }
    return handleRouteError(error);
  }
}

/** DELETE /api/connectors/:id — disconnect and delete the stored credentials. */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage connectors.', 403);
    }
    await disconnect({
      companyId: company.id,
      userId: user.id,
      connectorId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ disconnected: true });
  } catch (error) {
    if (error instanceof ConnectorError) {
      return jsonError(error.message, error.status);
    }
    return handleRouteError(error);
  }
}
