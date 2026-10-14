import { z } from 'zod';
import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';

/**
 * Campaigns — minimal CRUD so Content Studio can tag a draft to a campaign.
 * Full Campaign Builder UI arrives in a later sprint (model stubbed in Sprint 3).
 */
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(1000).optional(),
});

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const campaigns = await db.campaign.findMany({
      where: { companyId: company.id, status: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, goal: true, status: true },
    });
    return jsonOk({ campaigns });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request) {
  try {
    const { company, membership } = await requireActiveCompany();
    // Creating a campaign is creating content work: VIEWERs cannot.
    if (!can(membership.role, 'content:create')) {
      return jsonError('You don’t have permission to create campaigns.', 403);
    }
    const input = createSchema.parse(await req.json());
    const campaign = await db.campaign.create({
      data: { companyId: company.id, name: input.name, goal: input.goal ?? null },
      select: { id: true, name: true, goal: true, status: true },
    });
    return jsonOk(campaign, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
