import { requireActiveCompany } from '@/lib/auth-helpers';
import { updateDraftSchema } from '@/lib/validations/content';
import { getDraft, updateDraftBody } from '@/server/content/content.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/** GET — a single draft (scoped to the active company). */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    return jsonOk(draft);
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH — save manual edits to the draft body (validated per type). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, user } = await requireActiveCompany();
    const input = updateDraftSchema.parse(await req.json());
    const draft = await updateDraftBody({
      companyId: company.id,
      userId: user.id,
      draftId: params.id,
      title: input.title,
      body: input.body,
    });
    return jsonOk({ id: draft.id, status: draft.status });
  } catch (error) {
    return handleRouteError(error);
  }
}
