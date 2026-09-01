import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import {
  ensureTrendConfig,
  getEnabledFlags,
  updateTrendConfig,
} from '@/server/services/trend-config.service';
import { updateTrendConfigSchema } from '@/lib/validations/trends';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Reads the session, so it can never be statically prerendered. Declaring it
// keeps the build output clean instead of logging a fallback for every build.
export const dynamic = 'force-dynamic';

/** GET /api/trends/config — the active company's trend configuration. */
export async function GET() {
  try {
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active company', 400);
    const membership = await getMembership(user.id, active.id);
    if (!membership) return jsonError('Forbidden', 403);

    const config = await ensureTrendConfig(active.id);
    return jsonOk({
      keywords: config.keywords,
      subreddits: config.subreddits,
      rssFeeds: config.rssFeeds,
      competitorNames: config.competitorNames,
      enabledSources: getEnabledFlags(config),
      geoCountry: config.geoCountry,
      geoRegion: config.geoRegion,
      geoCity: config.geoCity,
      language: config.language,
      timeRangeDays: config.timeRangeDays,
      defaultsSeeded: config.defaultsSeeded,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PUT /api/trends/config — update the active company's trend configuration. */
export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active company', 400);
    const membership = await getMembership(user.id, active.id);
    if (!membership) return jsonError('Forbidden', 403);

    const input = updateTrendConfigSchema.parse(await req.json());
    const config = await updateTrendConfig({
      companyId: active.id,
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({
      keywords: config.keywords,
      subreddits: config.subreddits,
      rssFeeds: config.rssFeeds,
      competitorNames: config.competitorNames,
      enabledSources: getEnabledFlags(config),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
