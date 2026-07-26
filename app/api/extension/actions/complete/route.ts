import { z } from 'zod';
import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  extError,
  handleExtensionError,
} from '@/lib/extension-auth';
import { completeAction, actionsToday } from '@/server/extension/action.service';
import { getRequestMeta } from '@/lib/api';
import { EXTENSION_DAILY_CAP } from '@/lib/extension-constants';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  itemType: z.enum(['content_draft', 'outreach_message', 'engagement_comment']),
  itemId: z.string().min(1),
  postedUrl: z.string().url().optional(),
});

export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

/**
 * POST /api/extension/actions/complete — the human clicked send in the
 * extension; record the item as published/sent/posted (bearer auth). The
 * backend performs NO LinkedIn action — it only records the human's action.
 * Enforces the daily cap server-side as defense-in-depth (the extension already
 * caps client-side).
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireExtensionAuth(req);

    const count = await actionsToday(ctx.userId);
    if (count >= EXTENSION_DAILY_CAP) {
      return extError(
        req,
        `Daily action limit reached (${EXTENSION_DAILY_CAP}). This safety cap keeps your LinkedIn account healthy.`,
        429,
      );
    }

    const body = bodySchema.parse(await req.json());
    const result = await completeAction({
      ctx,
      itemType: body.itemType,
      itemId: body.itemId,
      postedUrl: body.postedUrl ?? null,
      requestMeta: getRequestMeta(req),
    });
    return extJson(req, result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return extError(req, 'Invalid request body.', 422);
    }
    return handleExtensionError(req, error);
  }
}
