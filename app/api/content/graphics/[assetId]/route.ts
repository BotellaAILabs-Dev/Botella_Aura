import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  attachedAssetIds,
  deleteAsset,
  getAsset,
  toAssetView,
} from '@/server/media/asset.service';

// Session-scoped, so it must never be statically prerendered.
export const dynamic = 'force-dynamic';

/** GET — one graphic's metadata (never its bytes; those have their own route). */
export async function GET(
  req: Request,
  { params }: { params: { assetId: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const asset = await getAsset(company.id, params.assetId);

    // Whether it is currently attached is only meaningful against a draft, so
    // the caller says which one it is looking at.
    const draftId = new URL(req.url).searchParams.get('draftId');
    const attached = draftId
      ? await attachedAssetIds(company.id, draftId)
      : new Set<string>();

    return jsonOk(toAssetView(asset, attached));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE — remove a graphic permanently (refused if it was published). */
export async function DELETE(
  _req: Request,
  { params }: { params: { assetId: string } },
) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot delete graphics.', 403);
    }
    await deleteAsset({
      companyId: company.id,
      userId: user.id,
      assetId: params.assetId,
    });
    return jsonOk({ deleted: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
