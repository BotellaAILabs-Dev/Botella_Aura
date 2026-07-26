import { db } from '@/lib/db';
import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  handleExtensionError,
} from '@/lib/extension-auth';
import { actionsToday } from '@/server/extension/action.service';
import { getQueue } from '@/server/extension/queue.service';
import {
  EXTENSION_DAILY_CAP,
  EXTENSION_HOURLY_CAP,
} from '@/lib/extension-constants';

export const dynamic = 'force-dynamic';

/** CORS preflight. */
export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

/** GET /api/extension/status — bearer-auth connection + usage summary. */
export async function GET(req: Request) {
  try {
    const ctx = await requireExtensionAuth(req);
    const [company, count, queue] = await Promise.all([
      db.company.findUnique({
        where: { id: ctx.companyId },
        select: { name: true },
      }),
      actionsToday(ctx.userId),
      getQueue(ctx.companyId),
    ]);
    return extJson(req, {
      connected: true,
      company: company?.name ?? null,
      role: ctx.membership.role,
      actionsToday: count,
      dailyCap: EXTENSION_DAILY_CAP,
      hourlyCap: EXTENSION_HOURLY_CAP,
      queueCount: queue.length,
    });
  } catch (error) {
    return handleExtensionError(req, error);
  }
}
