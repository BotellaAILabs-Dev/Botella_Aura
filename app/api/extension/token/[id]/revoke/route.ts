import { requireActiveCompany } from '@/lib/auth-helpers';
import { revokeExtensionToken } from '@/server/extension/token.service';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/** POST /api/extension/token/:id/revoke — "Disconnect extension" (session auth). */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company } = await requireActiveCompany();
    await revokeExtensionToken({
      userId: user.id,
      companyId: company.id,
      tokenId: params.id,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
