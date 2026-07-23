import { createCompanySchema } from '@/lib/validations/company';
import {
  createCompanyForUser,
  getCompaniesForUser,
} from '@/server/services/company.service';
import { requireUser } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonOk } from '@/lib/api';
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
    const input = createCompanySchema.parse(await req.json());

    const company = await createCompanyForUser({
      userId: user.id,
      input,
      requestMeta: getRequestMeta(req),
    });

    return jsonOk({ id: company.id, slug: company.slug, name: company.name }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
