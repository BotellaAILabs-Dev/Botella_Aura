import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { zonedToUtc } from '@/lib/timezone';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { workspaceTimeZone } from '@/server/scheduling/schedule-input';
import { draftPublishingState, publishOptionsSchema, requestWebsitePublish } from '@/server/websites/publish.service';

/**
 * GET  /api/content/drafts/:id/website-publish — this blog on each connected
 *      website: its state, what would be sent, and the preview.
 * POST /api/content/drafts/:id/website-publish
 *      { websiteId, action: "publish" | "draft" | "schedule", scheduledFor?, scheduleMode?, options? }
 *        publish   publish now (live)
 *        draft     save it on the site as an unpublished draft, now
 *        schedule  at `scheduledFor` (local "YYYY-MM-DDTHH:MM" in the
 *                  workspace timezone), live or as a draft (scheduleMode)
 */
export const dynamic = 'force-dynamic';
// Uploading images and waiting for the site can take a while.
export const maxDuration = 60;

const bodySchema = z.object({
  websiteId: z.string().min(1),
  action: z.enum(['publish', 'draft', 'schedule']),
  scheduledFor: z.string().optional(),
  scheduleMode: z.enum(['publish', 'draft']).optional(),
  options: publishOptionsSchema.optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, membership } = await requireActiveCompany();
    const state = await draftPublishingState(company.id, params.id);
    return jsonOk({ ...state, canPublish: can(membership.role, 'content:publish') });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    const input = bodySchema.parse(await req.json());
    let when: { kind: 'now' } | { kind: 'later'; at: Date } = { kind: 'now' };
    if (input.action === 'schedule') {
      if (!input.scheduledFor) return jsonError('Choose when to publish.', 422);
      when = { kind: 'later', at: zonedToUtc(input.scheduledFor, await workspaceTimeZone(company.id)).at };
    }
    const publication = await requestWebsitePublish({
      companyId: company.id,
      userId: user.id,
      role: membership.role,
      draftId: params.id,
      websiteId: input.websiteId,
      mode: input.action === 'draft' ? 'draft' : input.action === 'schedule' ? (input.scheduleMode ?? 'publish') : 'publish',
      when,
      options: input.options,
    });
    return jsonOk({ publication });
  } catch (error) {
    return handleRouteError(error);
  }
}
