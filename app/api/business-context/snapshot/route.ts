import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  SNAPSHOT_VIEW_NAMES,
  type SnapshotView,
} from '@/lib/business-context-snapshot';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';

/**
 * The Business Context Snapshot for the active workspace.
 *
 * GET  ?view=content|recommendation|opportunity|planning|outreach|engagement|full
 *      &strict=1  — the current snapshot for that workflow, rebuilt first if
 *      any source changed or it has expired. `status` and `reason` say which.
 * POST { view?, strict? } — rebuild now, whatever the stored state. For use
 *      right after a bulk change, or when someone wants to see it refreshed.
 */
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  view: z
    .enum(SNAPSHOT_VIEW_NAMES as [SnapshotView, ...SnapshotView[]])
    .default('full'),
  strict: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const { view, strict } = querySchema.parse(params);
    const result = await getContextSnapshot(company.id, { view, strict });
    if (!result) return jsonError('Company not found', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request) {
  try {
    const { company, membership } = await requireActiveCompany();
    // Rebuilding is cheap and changes nothing the business stated, but it is
    // still a write, so viewers cannot trigger it.
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can refresh the snapshot.', 403);
    }
    const body = await req.json().catch(() => ({}));
    const { view, strict } = querySchema.parse(body ?? {});
    const result = await getContextSnapshot(company.id, {
      view,
      strict,
      force: true,
    });
    if (!result) return jsonError('Company not found', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
