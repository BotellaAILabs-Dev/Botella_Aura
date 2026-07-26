import { requireActiveCompany } from '@/lib/auth-helpers';
import { outreachOutcomeSchema } from '@/lib/validations/memory';
import { setOutreachOutcome } from '@/server/memory/performance.service';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';

/**
 * POST /api/outreach/messages/:id/outcome — the user manually confirms whether
 * a sent outreach worked (connection accepted / reply received). No API exposes
 * this, so it's a human toggle — the "did it work" signal for Marketing Memory.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company } = await requireActiveCompany();
    const input = outreachOutcomeSchema.parse(await req.json());
    const message = await setOutreachOutcome({
      companyId: company.id,
      userId: user.id,
      messageId: params.id,
      connectionAccepted: input.connectionAccepted,
      replyReceived: input.replyReceived,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk({
      id: message.id,
      connectionAccepted: message.connectionAccepted,
      replyReceived: message.replyReceived,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
