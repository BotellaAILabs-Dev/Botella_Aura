import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import {
  getLatestBriefing,
  markBriefingRead,
  toBriefingView,
} from '@/server/briefing/briefing.service';
import { runAutopilot } from '@/server/briefing/autopilot.service';

export const dynamic = 'force-dynamic';
/** A manual run writes posts and images; it needs the same budget as the cron. */
export const maxDuration = 300;

/**
 * GET /api/briefing — the latest weekly briefing for the active workspace.
 *
 * Returns the most recent one rather than strictly this week's: on a Monday
 * before the cron has run, last week's briefing is far more useful than an
 * empty screen, and `isCurrentWeek` lets the UI label it honestly.
 */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const row = await getLatestBriefing(company.id);
    return jsonOk({ briefing: row ? toBriefingView(row) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/briefing — run the cycle now ("catch me up").
 *
 * Deliberately the same code path as the cron, so what a person triggers by
 * hand and what runs on Monday morning cannot drift apart. `force` re-runs a
 * week that already ran, which is the point of a manual refresh — and it is
 * why this is gated on content:create and rate-limited: each run can write
 * posts and generate images.
 */
export async function POST(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot run the agent.', 403);
    }

    // A manual run spends money. Twice an hour is generous for "catch me up"
    // and far below anything that could run up a bill by accident.
    const limit = rateLimit(`briefing-run:${company.id}`, {
      limit: 2,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Aura already ran recently. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
        429,
      );
    }

    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const result = await runAutopilot({
      companyId: company.id,
      userId: user.id,
      force: body.force === true,
    });

    const row = await getLatestBriefing(company.id);
    return jsonOk({
      ran: result.ran,
      reason: result.reason ?? null,
      activity: result.activity,
      briefing: row ? toBriefingView(row) : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/briefing — mark the current briefing as read. */
export async function PATCH(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const { briefingId } = (await req.json().catch(() => ({}))) as {
      briefingId?: string;
    };
    if (!briefingId) return jsonError('A briefingId is required.', 400);

    await markBriefingRead(company.id, briefingId);
    return jsonOk({ read: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
