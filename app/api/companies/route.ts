import { createCompanySchema } from '@/lib/validations/company';
import {
  createCompanyForUser,
  getCompaniesForUser,
} from '@/server/services/company.service';
import { requireUser } from '@/lib/auth-helpers';
import { enqueueJob } from '@/server/jobs/job.service';
import { logger } from '@/lib/logger';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import type { CompaniesResponse } from '@/types';

/** GET /api/companies — companies the current user belongs to (topbar switcher). */
export async function GET() {
  try {
    const user = await requireUser();
    const companies = await getCompaniesForUser(user.id);
    const body: CompaniesResponse = {
      companies,
      activeCompanyId: companies[0]?.id ?? null,
    };
    return jsonOk(body);
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/companies — create a company (onboarding wizard submit). */
export async function POST(req: Request) {
  try {
    const user = await requireUser();

    // Read the body ONCE. A request body is a single-use stream: consuming it
    // and then calling req.clone() throws `TypeError: unusable`, which is a
    // synchronous throw that a .catch() on the following .json() never sees —
    // so every workspace creation failed with an opaque 500.
    const raw = (await req.json()) as unknown;
    const input = createCompanySchema.parse(raw);

    /**
     * Guard against accidentally creating the same workspace twice.
     *
     * Slugs are uniquified automatically, so a repeated submit — a double
     * click, a back-navigation, a retried onboarding — silently produced a
     * second workspace with an identical name. The user then has two
     * indistinguishable entries in the switcher, and their data is split
     * across both with no hint as to which is which.
     *
     * `confirmDuplicate` lets someone who genuinely wants a second workspace
     * of the same name proceed, so this blocks the accident without blocking
     * the intent.
     */
    const confirmDuplicate = Boolean(
      (raw as { confirmDuplicate?: unknown } | null)?.confirmDuplicate,
    );

    if (!confirmDuplicate) {
      const existing = await getCompaniesForUser(user.id);
      const clash = existing.find(
        (c) => c.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
      );
      if (clash) {
        return jsonError(
          `You already have a workspace called “${clash.name}”. Open that one, or confirm if you really want a second workspace with the same name.`,
          409,
        );
      }
    }

    const company = await createCompanyForUser({
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });

    /**
     * Queue the first intelligence run the moment onboarding ends.
     *
     * Previously the dashboard opened blank and stayed that way until the user
     * found the "Run analysis" button — most never did. The foundations scorer
     * can grade a workspace from onboarding data alone, so there is genuinely
     * something to show; queuing it here means it is ready by the time they
     * arrive. Best-effort: a workspace must still be created if this fails.
     */
    try {
      const { job } = await enqueueJob({
        companyId: company.id,
        userId: user.id,
        kind: 'INTELLIGENCE',
      });
      return jsonOk(
        {
          id: company.id,
          slug: company.slug,
          name: company.name,
          // The client kicks this so the first analysis runs immediately
          // rather than waiting for the cron reaper.
          intelligenceJobId: job.id,
        },
        201,
      );
    } catch (err) {
      logger.warn('companies: could not queue first intelligence run', {
        companyId: company.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonOk({ id: company.id, slug: company.slug, name: company.name }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
