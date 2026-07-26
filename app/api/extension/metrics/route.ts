import { z } from 'zod';
import {
  requireExtensionAuth,
  handleOptions,
  extJson,
  extError,
  handleExtensionError,
} from '@/lib/extension-auth';
import { extensionMetricsSchema } from '@/lib/validations/memory';
import { recordContentMetrics } from '@/server/memory/performance.service';
import { getRequestMeta } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request) {
  return handleOptions(req);
}

/**
 * POST /api/extension/metrics — the extension reads the like/comment counts
 * already rendered on the user's OWN post page and syncs them (Sprint 5).
 * Same "only what's visible in your own DOM" constraint as the Engagement
 * Copilot — no server-side LinkedIn fetch. Bearer auth. Real numbers only.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireExtensionAuth(req);
    const { postUrl, ...metrics } = extensionMetricsSchema.parse(await req.json());
    const result = await recordContentMetrics({
      companyId: ctx.companyId,
      userId: ctx.userId,
      postUrl,
      metrics,
      source: 'EXTENSION_DOM',
      requestMeta: getRequestMeta(req),
    });
    return extJson(req, result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return extError(req, 'Invalid metrics payload.', 422);
    }
    return handleExtensionError(req, error);
  }
}
