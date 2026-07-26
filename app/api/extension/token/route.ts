import { z } from 'zod';
import { requireActiveCompany } from '@/lib/auth-helpers';
import {
  issueExtensionToken,
  listExtensionTokens,
} from '@/server/extension/token.service';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/**
 * Session-authenticated (same-origin) endpoints to issue + list extension
 * tokens. The raw token is returned exactly ONCE on issue; thereafter only
 * non-secret metadata is listable.
 */
const issueSchema = z.object({ label: z.string().trim().max(80).optional() });

/** GET /api/extension/token — list the caller's active tokens. */
export async function GET() {
  try {
    const { user, company } = await requireActiveCompany();
    const tokens = await listExtensionTokens(user.id, company.id);
    return jsonOk({ tokens });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/extension/token — issue a new token (returns the raw token once). */
export async function POST(req: Request) {
  try {
    const { user, company } = await requireActiveCompany();
    const { label } = issueSchema.parse(await req.json().catch(() => ({})));
    const issued = await issueExtensionToken({
      userId: user.id,
      companyId: company.id,
      label,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(
      { id: issued.id, token: issued.rawToken, expiresAt: issued.expiresAt },
      201,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
