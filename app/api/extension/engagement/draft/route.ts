import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  extError,
  handleExtensionError,
} from '@/lib/extension-auth';
import { draftCommentSchema } from '@/lib/validations/engagement';
import { draftComment } from '@/server/engagement/comment.service';
import { actionsToday } from '@/server/extension/action.service';
import { getRequestMeta } from '@/lib/api';
import { z } from 'zod';
import { can } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

/**
 * POST /api/extension/engagement/draft — the extension sends the text of a post
 * ALREADY VISIBLE in the user's own browser DOM; we return an on-brand comment
 * draft. No server-side LinkedIn fetch happens here (constraint #2). Bearer auth.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireExtensionAuth(req);
    // Drafting a comment is creating content: not for read-only roles.
    if (!can(ctx.membership.role, 'content:create')) {
      return extError(req, 'Your role is read-only and cannot draft comments.', 403);
    }
    const body = draftCommentSchema.parse(await req.json());

    const result = await draftComment({
      companyId: ctx.companyId,
      userId: ctx.userId,
      postUrl: body.postUrl,
      postText: body.postText,
      author: body.author ?? null,
      requestMeta: getRequestMeta(req),
    });

    const usedToday = await actionsToday(ctx.userId);
    return extJson(req, { ...result, actionsToday: usedToday });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return extError(req, 'Invalid request body.', 422);
    }
    return handleExtensionError(req, error);
  }
}
