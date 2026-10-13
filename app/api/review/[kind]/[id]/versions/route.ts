import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  listVersions,
  restoreVersion,
} from '@/server/versions/version-api.service';

/**
 * Versions of one item of generated work (lib/versions.ts).
 *
 *   GET  — every version, newest first: who made it and when, how (generated,
 *          edited, regenerated, variation, undo, restored), its text, and
 *          which is the original, the current and the approved one
 *   POST — { version } make that version current. It comes back as a new
 *          version, so nothing is overwritten; approved work is reopened.
 */
export const dynamic = 'force-dynamic';

const kindSchema = z.enum(['content', 'outreach']);
const restoreSchema = z.object({ version: z.number().int().min(1) });

export async function GET(
  _req: Request,
  { params }: { params: { kind: string; id: string } },
) {
  try {
    const kind = kindSchema.safeParse(params.kind);
    if (!kind.success) return jsonError('Not found.', 404);
    const { company } = await requireActiveCompany();
    const result = await listVersions(kind.data, company.id, params.id);
    if (!result) return jsonError('Not found.', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: { kind: string; id: string } },
) {
  try {
    const kind = kindSchema.safeParse(params.kind);
    if (!kind.success) return jsonError('Not found.', 404);
    const { company, user, membership } = await requireActiveCompany();
    const { version } = restoreSchema.parse(await req.json());
    const result = await restoreVersion({
      kind: kind.data,
      companyId: company.id,
      userId: user.id,
      role: membership.role,
      id: params.id,
      version,
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
