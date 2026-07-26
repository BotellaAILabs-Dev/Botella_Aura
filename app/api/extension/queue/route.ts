import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  handleExtensionError,
} from '@/lib/extension-auth';
import { getQueue } from '@/server/extension/queue.service';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

/** GET /api/extension/queue — items awaiting a human click (bearer auth). */
export async function GET(req: Request) {
  try {
    const ctx = await requireExtensionAuth(req);
    const items = await getQueue(ctx.companyId);
    return extJson(req, { items });
  } catch (error) {
    return handleExtensionError(req, error);
  }
}
