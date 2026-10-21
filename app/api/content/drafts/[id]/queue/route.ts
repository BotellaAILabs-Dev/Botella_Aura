import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { queueDraftSchema } from '@/lib/validations/media';
import { resolveSchedule, scheduleInputSchema } from '@/server/scheduling/schedule-input';
import { queueDraft, getDraft } from '@/server/content/content.service';
import { getAttachedMedia } from '@/server/media/asset.service';
import { resolvePlatform, platformSpec } from '@/lib/platforms';
import { isCopyOnlyType, type ContentTypeKey } from '@/lib/validations/content';

/**
 * POST /api/content/drafts/:id/queue — "Add to queue" from the post composer.
 *
 * Composes what the user assembled — copy, graphic, platform, time — into the
 * EXISTING queue: it sets the platform and schedule and moves the draft to
 * PENDING_APPROVAL. There is no second queue and no second scheduler; the same
 * `runScheduledPublishes()` cron picks it up once a human approves it.
 *
 * Requires `content:create`, not `content:publish`. Queueing is asking for
 * review, and a MEMBER who can draft should be able to ask — the approval that
 * actually authorises publishing is still gated separately.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot queue posts.', 403);
    }

    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = queueDraftSchema.parse(raw);
    const hasTime = typeof raw.localTime === 'string' || Boolean(input.scheduledFor);

    const existing = await getDraft(company.id, params.id);
    if (!existing) return jsonError('Draft not found', 404);
    // An APPROVED post keeps its approval here, so giving it a time IS
    // scheduling its publication — the same permission as /schedule.
    if (existing.status === 'APPROVED' && hasTime && !can(membership.role, 'content:publish')) {
      return jsonError('Only people who can publish can schedule an approved post.', 403);
    }
    // A time given as a wall time in the workspace's zone (or an exact instant);
    // validated after the permission check, so a refusal is about the role first.
    const when =
      hasTime
        ? await resolveSchedule(
            company.id,
            scheduleInputSchema.parse(
              typeof raw.localTime === 'string'
                ? { localTime: raw.localTime, ...(typeof raw.timeZone === 'string' ? { timeZone: raw.timeZone } : {}) }
                : { scheduledFor: input.scheduledFor },
            ),
          )
        : null;
    if (isCopyOnlyType(existing.type as ContentTypeKey)) {
      return jsonError(
        'Email and ad copy are sent from your email tool or ad manager, not queued for publishing — copy it out instead.',
        409,
      );
    }

    const platform = resolvePlatform(
      existing.type as ContentTypeKey,
      input.platform ?? existing.platform,
    );
    const spec = platformSpec(platform);

    // Refuse now rather than at publish time: an Instagram post with no image
    // cannot be published at all, so queueing one only defers the bad news.
    const media = await getAttachedMedia({
      companyId: company.id,
      draftId: params.id,
      type: existing.type as ContentTypeKey,
      platform,
    });
    if (spec.requiresMedia && media.length === 0) {
      return jsonError(
        `${spec.label} posts need an image. Generate a graphic and attach it before queueing.`,
        422,
      );
    }

    const blocking = media.flatMap((item) => item.problems);
    if (blocking.length > 0) {
      return jsonError(
        `The attached graphic isn't valid for ${spec.label}: ${blocking.join(' ')}`,
        422,
      );
    }

    const draft = await queueDraft({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      platform,
      ...(when ? { scheduledFor: when.at, timeZone: when.timeZone, local: when.local } : {}),
    });

    return jsonOk({
      id: draft.id,
      status: draft.status,
      platform: draft.platform,
      scheduledFor: draft.scheduledFor,
      ...(when ? { timeZone: when.timeZone, local: when.local, note: when.note } : {}),
      mediaCount: media.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
